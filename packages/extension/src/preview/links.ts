/**
 * Decides whether a link the preview page reports can leave the page. This is
 * URI-only so it works in desktop and browser hosts without a file-system API.
 */
export type PreviewLinkDecision =
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'workspace'; readonly href: string; readonly line?: number }
  | { readonly kind: 'refused' };

function sameAuthority(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.username === right.username && left.password === right.password &&
    left.hostname === right.hostname && left.port === right.port;
}

function contains(folder: URL, target: URL): boolean {
  const root = folder.pathname.endsWith('/') ? folder.pathname.slice(0, -1) : folder.pathname;
  return sameAuthority(folder, target) && (target.pathname === root || target.pathname.startsWith(`${root}/`));
}

function lineOf(fragment: string): number | undefined {
  const match = /^L(\d+)(?:-L?\d+)?$/i.exec(fragment);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * Relative links resolve beside the previewed document and must stay in a
 * workspace folder. Explicit file and command URLs are never trusted merely
 * because the page sent them; an explicit file URL is accepted only when it is
 * within a supplied workspace folder.
 */
export function decidePreviewLink(source: string, href: string, workspaceFolders: readonly string[]): PreviewLinkDecision {
  let target: URL;
  try {
    target = new URL(href, source);
  } catch {
    return { kind: 'refused' };
  }
  if (target.protocol === 'http:' || target.protocol === 'https:') return { kind: 'external', href: target.toString() };
  let folders: URL[];
  try {
    folders = workspaceFolders.map((folder) => new URL(folder));
  } catch {
    return { kind: 'refused' };
  }
  if (!folders.some((folder) => contains(folder, target))) return { kind: 'refused' };
  const fragment = target.hash.slice(1);
  const line = lineOf(fragment);
  return { kind: 'workspace', href: target.toString(), ...(line === undefined ? {} : { line }) };
}
