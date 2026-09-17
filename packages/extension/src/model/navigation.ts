import * as vscode from 'vscode';
import type { LspRange } from '../lsp/requests.js';

/**
 * Opening what the server points at. Shared by the model actions (007) and meant
 * for the model explorer (006), so a target opens the same way from the editor
 * and from the tree.
 */

/** Anything the server names as a place: a navigation target, or a hierarchy node's `sourceUri`/`sourceRange`. */
export interface ServerLocation {
  readonly uri: string;
  readonly range?: LspRange;
}

/**
 * A location the editor can navigate. A target without a range opens at the start
 * of its document: that is all the server said.
 */
export function toLocation(target: ServerLocation): vscode.Location {
  const range = target.range
    ? new vscode.Range(target.range.start.line, target.range.start.character, target.range.end.line, target.range.end.character)
    : new vscode.Range(0, 0, 0, 0);
  return new vscode.Location(vscode.Uri.parse(target.uri), range);
}

/** Opens a location with its start selected, in a regular (non-preview-replacing) way. */
export async function openLocation(location: vscode.Location): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(location.uri);
  return vscode.window.showTextDocument(document, {
    selection: new vscode.Range(location.range.start, location.range.start),
    preview: true,
  });
}

export type PresentedLocations = 'navigated' | 'listed' | 'none';

/**
 * Shows locations with the editor's own presentation: one location is opened
 * directly, several are listed in the peek view anchored at `anchor`, none
 * reports `noneMessage`.
 */
export async function presentLocations(
  anchor: vscode.Location,
  locations: readonly vscode.Location[],
  noneMessage: string,
): Promise<PresentedLocations> {
  if (locations.length === 0) {
    void vscode.window.showInformationMessage(noneMessage);
    return 'none';
  }
  if (locations.length === 1) {
    await openLocation(locations[0]!);
    return 'navigated';
  }
  await vscode.commands.executeCommand('editor.action.goToLocations',
    anchor.uri, anchor.range.start, [...locations], 'peek', noneMessage);
  return 'listed';
}
