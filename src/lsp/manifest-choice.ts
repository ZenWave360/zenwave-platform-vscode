import * as vscode from 'vscode';
import { parseManifestUrl } from './manifest-resolution.js';

/** What the user chose with **Choose Architecture Manifest…**: a file on disk (or in a virtual file system) or an `http(s)` address. */
export type ManifestChoice =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly uri: vscode.Uri };

/**
 * The command's argument when it is run without asking (tests, other commands): `{ url }` or `{ file }` with a URI string.
 * Anything else asks.
 */
export function choiceFromArgument(argument: unknown): ManifestChoice | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const { url, file } = argument as { url?: unknown; file?: unknown };
  if (typeof url === 'string') {
    const parsed = parseManifestUrl(url);
    return 'url' in parsed ? { kind: 'url', url: parsed.url } : undefined;
  }
  if (typeof file === 'string') return { kind: 'file', uri: vscode.Uri.parse(file, true) };
  return undefined;
}

/** Asks for a manifest: *Local file…* or *URL…*. `undefined` when the user backs out. */
export async function askManifest(): Promise<ManifestChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Local file…', description: 'A zenwave-architecture.yml on this machine or in the workspace', how: 'file' as const },
      { label: 'URL…', description: 'An http or https address', how: 'url' as const },
    ],
    { title: 'Choose Architecture Manifest', placeHolder: 'Where is the architecture manifest?' },
  );
  if (!picked) return undefined;
  if (picked.how === 'file') {
    const [uri] = (await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Choose Manifest',
      title: 'Choose Architecture Manifest',
      filters: { 'YAML': ['yml', 'yaml'] },
    })) ?? [];
    return uri ? { kind: 'file', uri } : undefined;
  }
  const entered = await vscode.window.showInputBox({
    title: 'Choose Architecture Manifest',
    prompt: 'The address of the architecture manifest',
    placeHolder: 'https://example.org/zenwave-architecture.yml',
    validateInput: (text) => {
      const parsed = parseManifestUrl(text);
      return 'problem' in parsed ? parsed.problem : undefined;
    },
  });
  if (entered === undefined) return undefined;
  const parsed = parseManifestUrl(entered);
  return 'url' in parsed ? { kind: 'url', url: parsed.url } : undefined;
}

/** What `zenwave.workspace.manifest` holds for a choice: a path for a local file, otherwise the address. */
export function settingValue(choice: ManifestChoice): string {
  if (choice.kind === 'url') return choice.url;
  return choice.uri.scheme === 'file' ? choice.uri.fsPath : choice.uri.toString();
}

/** What a session override holds: the URI the server is initialised with. */
export function sessionValue(choice: ManifestChoice): string {
  return choice.kind === 'url' ? choice.url : choice.uri.toString();
}
