import type { ExplorerTree } from './hierarchy-model.js';

/**
 * Which document the Model tree shows. Pure: tab inputs are read by shape, so
 * the rules are testable without an editor.
 */

const MODEL_LANGUAGES = new Set(['zdl', 'zw', 'zfl']);
const MODEL_EXTENSIONS = /\.(zdl|zw|zfl)$/i;
const API_DESCRIPTION_LANGUAGES = new Set(['yaml', 'json', 'jsonc']);
const API_DESCRIPTION_KEYS = new Set(['openapi', 'swagger', 'asyncapi']);
const OUTLINE_SCAN_BYTES = 4 * 1024;
const OUTLINE_SCAN_LINES = 50;

export interface UriLike {
  readonly path: string;
  toString(): string;
}

export type ModelTreeSource = 'server' | 'outline';
export type OutlineKind = 'markdown' | 'api-description';

/** What a focused text document contributes. Absent when that document should leave the current model in place. */
export interface TextDocumentTarget {
  readonly uri: string;
  /** A ZenWave model uses the language server. Markdown, and an OpenAPI, Swagger or AsyncAPI description, use the host outline. */
  readonly source: ModelTreeSource;
  /** Which host outline is being shown; Markdown needs its built-in provider activated on first use. */
  readonly outlineKind?: OutlineKind;
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

/**
 * ZenWave languages call the ZenWave server. Markdown always uses the host's
 * outline. YAML and JSON only use it when their opening text identifies an
 * OpenAPI, Swagger or AsyncAPI description; any other text document leaves the
 * current model in place.
 */
export function targetForTextDocument(uri: UriLike, languageId: string, text = ''): TextDocumentTarget | undefined {
  if (isModelDocument(uri, languageId)) return { uri: uri.toString(), source: 'server' };
  if (languageId === 'markdown') return { uri: uri.toString(), source: 'outline', outlineKind: 'markdown' };
  return API_DESCRIPTION_LANGUAGES.has(languageId) && isApiDescription(text, languageId)
    ? { uri: uri.toString(), source: 'outline', outlineKind: 'api-description' }
    : undefined;
}

/** The bounded prefix used to decide whether a generic structured document is an API description. */
function outlinePrefix(text: string): string {
  return text.split(/\r?\n/, OUTLINE_SCAN_LINES).join('\n').slice(0, OUTLINE_SCAN_BYTES);
}

function skipsJsonTrivia(text: string, index: number): number {
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index++; continue; }
    if (text[index] !== '/') return index;
    if (text[index + 1] === '/') {
      index = text.indexOf('\n', index + 2);
      if (index < 0) return text.length;
      continue;
    }
    if (text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) return text.length;
      index = end + 2;
      continue;
    }
    return index;
  }
  return index;
}

/** Finds a top-level JSON/JSONC property without parsing the rest of the document. */
function jsonHasApiDescriptionKey(text: string): boolean {
  let index = skipsJsonTrivia(text, 0);
  if (text[index] === '\uFEFF') index = skipsJsonTrivia(text, index + 1);
  if (text[index] !== '{') return false;
  let depth = 1;
  for (index++; index < text.length;) {
    index = skipsJsonTrivia(text, index);
    const character = text[index];
    if (character === '{' || character === '[') { depth++; index++; continue; }
    if (character === '}' || character === ']') { depth--; index++; continue; }
    if (character !== '"') { index++; continue; }
    let key = '';
    index++;
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\') index++;
      key += text[index++] ?? '';
    }
    if (text[index] !== '"') return false;
    index = skipsJsonTrivia(text, index + 1);
    if (depth === 1 && text[index] === ':' && API_DESCRIPTION_KEYS.has(key)) return true;
  }
  return false;
}

/** A bounded, deliberately shallow discriminator; API semantics remain with their provider. */
export function isApiDescription(text: string, languageId: string): boolean {
  const prefix = outlinePrefix(text);
  if (languageId === 'yaml') return /^(?:\uFEFF)?(?:openapi|swagger|asyncapi)\s*:/m.test(prefix);
  return languageId === 'json' || languageId === 'jsonc' ? jsonHasApiDescriptionKey(prefix) : false;
}

/**
 * A tab that may hold the document the Model tree should show.
 * `uri` is absent for a webview, a diff, a terminal or a notebook: the tab is still
 * the focus, and it must not be treated as "no tab".
 */
export interface FocusedTab {
  readonly uri?: UriLike;
  /** A diagram, preview, image or other non-text tab (`TabInputCustom` or a webview). */
  readonly customEditor: boolean;
  readonly languageId?: string;
  /** Opening text of a text tab, from that tab's document, for the API-description check. */
  readonly text?: string;
}

/**
 * The document the Model tree should show for the current focus (ME-R3).
 *
 * The active tab decides. A text tab contributes its own document. A ZenWave
 * custom editor of a model document contributes that document. Any other custom
 * editor, webview or image keeps the current tree: a text editor left active in
 * another group is not the focus. `text` is used only when the editor reported
 * no active tab.
 */
export function focusedTreeTarget(text: TextDocumentTarget | undefined, tab: FocusedTab | undefined): TextDocumentTarget | undefined {
  if (!tab) return text;
  if (!tab.customEditor && tab.uri) {
    if (tab.languageId !== undefined) return targetForTextDocument(tab.uri, tab.languageId, tab.text ?? '');
    return isModelDocument(tab.uri, undefined) ? { uri: tab.uri.toString(), source: 'server' } : undefined;
  }
  if (tab.uri && isModelDocument(tab.uri, tab.languageId)) return { uri: tab.uri.toString(), source: 'server' };
  return undefined;
}

/**
 * An edit of a text document, after the quiet period. The tree moves onto the
 * host outline only when this is the active document and it now qualifies.
 * A document that stops qualifying, or an edit that is not the active document,
 * leaves the current tree in place.
 */
export function outlineRetarget(
  shown: { readonly uri: string; readonly source: ModelTreeSource } | undefined,
  edit: { readonly active: boolean; readonly uri: UriLike; readonly languageId: string; readonly text: string },
): TextDocumentTarget | undefined {
  if (!edit.active) return undefined;
  const target = targetForTextDocument(edit.uri, edit.languageId, edit.text);
  if (target?.source !== 'outline') return undefined;
  if (shown?.uri === target.uri && shown.source === target.source) return undefined;
  return target;
}

export type FollowDecision = 'retarget' | 'keep';

/**
 * Retarget when `focused` is not the document on screen and is not already a
 * document of the hierarchy on screen. No focused document keeps the tree.
 */
export function followDecision(shown: { readonly uri: string; readonly tree?: ExplorerTree } | undefined, focused: string | undefined): FollowDecision {
  if (focused === undefined) return 'keep';
  if (!shown) return 'retarget';
  if (shown.uri === focused) return 'keep';
  if (shown.tree?.sourceUris.has(focused)) return 'keep';
  return 'retarget';
}
