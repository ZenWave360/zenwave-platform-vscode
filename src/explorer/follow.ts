import type { ExplorerTree } from './hierarchy-model.js';

/**
 * Which document the Model tree shows. Pure: tab inputs are read by shape, so
 * the rules are testable without an editor.
 */

const MODEL_LANGUAGES = new Set(['zdl', 'zw', 'zfl']);
const MODEL_EXTENSIONS = /\.(zdl|zw|zfl)$/i;

export interface UriLike {
  readonly path: string;
  toString(): string;
}

/**
 * The document a tab holds, whether it is a text editor (`TabInputText`) or a
 * custom editor such as a preview or a diagram (`TabInputCustom`): both carry
 * `uri`. Diff, webview, terminal and notebook tabs hold no single model document.
 */
export function tabDocumentUri(input: unknown): UriLike | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  if ('original' in input || 'modified' in input) return undefined; // a diff
  const uri = (input as { uri?: unknown }).uri;
  if (typeof uri !== 'object' || uri === null) return undefined;
  const candidate = uri as Partial<UriLike>;
  return typeof candidate.path === 'string' && typeof candidate.toString === 'function' ? candidate as UriLike : undefined;
}

/**
 * Whether a document is a model: by the language of its open text document when
 * there is one (an untitled flow has no extension), otherwise by its extension
 * (a custom editor's document need not be open as text).
 */
export function isModelDocument(uri: UriLike, languageId: string | undefined): boolean {
  if (languageId !== undefined) return MODEL_LANGUAGES.has(languageId);
  return MODEL_EXTENSIONS.test(uri.path);
}

export type FollowDecision = 'retarget' | 'keep';

/**
 * The rule from the design: the tree retargets when the focused model document
 * is not already part of the hierarchy it is showing. A non-model tab never
 * retargets, so the last model stays on screen.
 */
export function followDecision(shown: { readonly uri: string; readonly tree?: ExplorerTree } | undefined, focused: string | undefined): FollowDecision {
  if (focused === undefined) return 'keep';
  if (!shown) return 'retarget';
  if (shown.uri === focused) return 'keep';
  if (shown.tree?.sourceUris.has(focused)) return 'keep';
  return 'retarget';
}
