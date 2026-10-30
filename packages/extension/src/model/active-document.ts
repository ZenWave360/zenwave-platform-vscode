import * as vscode from 'vscode';
import { tabDocumentUri } from '../explorer/follow.js';

/**
 * The model document the user is looking at, whatever kind of editor shows it.
 *
 * `window.activeTextEditor` is `undefined` while a custom editor (a diagram, a
 * preview) has focus, so palette commands read the active tab instead:
 * `TabInputText` and `TabInputCustom` both carry the document's `uri`.
 *
 * `accepts` decides which documents count, from the URI and, when the document
 * is open as text, its language (an untitled model has no extension).
 */
export function activeModelDocument(accepts: (uri: vscode.Uri, languageId: string | undefined) => boolean): vscode.Uri | undefined {
  const found = tabDocumentUri(vscode.window.tabGroups.activeTabGroup.activeTab?.input);
  if (!found || !(found instanceof vscode.Uri)) return undefined;
  const languageId = vscode.workspace.textDocuments.find((document) => document.uri.toString() === found.toString())?.languageId;
  return accepts(found, languageId) ? found : undefined;
}

/** A ZFL document: by its language when open as text, otherwise by its extension. */
export function isZflDocument(uri: vscode.Uri, languageId: string | undefined): boolean {
  if (languageId !== undefined) return languageId === 'zfl';
  return /\.zfl$/i.test(uri.path);
}

/**
 * A ZDL or ZFL document, the models that have a preview (`.zw` has none yet): by language when open as text,
 * otherwise by extension. An untitled buffer is not one: a preview is of a saved file.
 */
export function isPreviewableDocument(uri: vscode.Uri, languageId: string | undefined): boolean {
  if (uri.scheme === 'untitled') return false;
  if (languageId !== undefined) return languageId === 'zdl' || languageId === 'zfl';
  return /\.(zdl|zfl)$/i.test(uri.path);
}

/**
 * The command argument when a menu passed a URI (editor/title, explorer
 * context), otherwise the model document in the active tab.
 */
export function commandDocument(argument: unknown, accepts: (uri: vscode.Uri, languageId: string | undefined) => boolean): vscode.Uri | undefined {
  if (argument instanceof vscode.Uri) {
    const languageId = vscode.workspace.textDocuments.find((document) => document.uri.toString() === argument.toString())?.languageId;
    return accepts(argument, languageId) ? argument : undefined;
  }
  return activeModelDocument(accepts);
}
