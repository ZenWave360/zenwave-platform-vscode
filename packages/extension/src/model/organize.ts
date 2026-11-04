import type { OrganizeServicesMode } from '../lsp/requests.js';

/**
 * Where the two organise actions sit, and which `mode` they send.
 *
 * The lens range is the `systems` keyword. VS Code draws a CodeLens above that
 * line, so the actions sit above the systems block. Finding that keyword is a
 * scan of the text, not a reading of the model: comments, strings and a
 * `systems` name nested in another block are not the block.
 */

export type OrganizeAction = 'full' | 'additive';

export const FULL_ORGANIZE_CONFIRMATION = 'Organize services in full? This also removes what no flow uses: systems, services, commands and aggregates.';
export const FULL_ORGANIZE_ACCEPT = 'Organize in Full';

export interface OrganizeLens {
  readonly title: 'Add missing' | 'Full';
  readonly action: OrganizeAction;
  /** Offsets of the `systems` keyword in the document text. */
  readonly start: number;
  readonly end: number;
}

export type OrganizeDecision =
  | { readonly kind: 'confirm'; readonly message: string; readonly accept: string }
  | { readonly kind: 'send'; readonly mode: OrganizeServicesMode | undefined }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' };

const SYSTEMS = 'systems';

/**
 * Lenses for a ZFL document. None when it has no `systems` block: the palette
 * commands still apply, and the server can create the block. Add missing is
 * included only when the server advertised `organizeModes`.
 */
export function organizeLenses(text: string, organizeModes: boolean): readonly OrganizeLens[] {
  const keyword = systemsKeyword(text);
  if (!keyword) return [];
  const full: OrganizeLens = { title: 'Full', action: 'full', start: keyword.start, end: keyword.end };
  if (!organizeModes) return [full];
  return [{ title: 'Add missing', action: 'additive', start: keyword.start, end: keyword.end }, full];
}

/**
 * What an action does before a request is sent.
 *
 * Full always confirms. Cancel sends nothing. Accept sends `full` when the
 * server advertised the mode, and omits `mode` otherwise, which is what an
 * older server already does. Add missing is refused when the server did not
 * advertise the mode, so a client never asks an older server to remove things.
 */
export function decideOrganize(
  action: OrganizeAction,
  organizeModes: boolean,
  answer: 'accepted' | 'cancelled' | undefined = undefined,
): OrganizeDecision {
  if (action === 'additive') {
    return organizeModes ? { kind: 'send', mode: 'additive' } : { kind: 'unsupported' };
  }
  if (answer === undefined) return { kind: 'confirm', message: FULL_ORGANIZE_CONFIRMATION, accept: FULL_ORGANIZE_ACCEPT };
  if (answer === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'send', mode: organizeModes ? 'full' : undefined };
}

function systemsKeyword(text: string): { start: number; end: number } | undefined {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === '\'') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth === 0 && isSystemsKeyword(text, i)) {
      const end = i + SYSTEMS.length;
      const brace = indexAfterGap(text, end);
      // An unclosed comment between the keyword and the brace swallows the rest of the file.
      if (brace === undefined) return undefined;
      if (text[brace] === '{') return { start: i, end };
      i = end;
      continue;
    }
    i++;
  }
  return undefined;
}

/** The next code character after whitespace and comments. Undefined when a comment never closes. */
function indexAfterGap(text: string, start: number): number | undefined {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    return i;
  }
  return i;
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n' || c === '\r') return i;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

function isSystemsKeyword(text: string, index: number): boolean {
  return text.startsWith(SYSTEMS, index) && !isIdent(text[index - 1]) && !isIdent(text[index + SYSTEMS.length]);
}

function isIdent(char: string | undefined): boolean {
  return char !== undefined && (
    (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_'
  );
}
