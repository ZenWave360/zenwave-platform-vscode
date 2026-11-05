import * as vscode from 'vscode';

/**
 * Replaces a tab with another view of the same document, keeping its place among
 * the tabs: open the replacement in the tab's group, close the tab, and move the
 * replacement to the index the tab had.
 */
export async function replaceInPlace(tab: vscode.Tab, open: (column: vscode.ViewColumn) => Thenable<unknown>): Promise<void> {
  const column = tab.group.viewColumn;
  const index = tab.group.tabs.indexOf(tab);
  const input = tab.input;
  await open(column);
  const group = vscode.window.tabGroups.all.find((candidate) => candidate.viewColumn === column);
  const original = group?.tabs.find((candidate) => sameInput(candidate.input, input));
  if (original && !original.isDirty) await vscode.window.tabGroups.close(original, true);
  const active = vscode.window.tabGroups.activeTabGroup;
  const position = active.activeTab ? active.tabs.indexOf(active.activeTab) : -1;
  if (active.viewColumn === column && index >= 0 && position >= 0 && position !== index) {
    await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
  }
}

export function sameInput(a: unknown, b: unknown): boolean {
  if (a instanceof vscode.TabInputText && b instanceof vscode.TabInputText) return a.uri.toString() === b.uri.toString();
  if (a instanceof vscode.TabInputCustom && b instanceof vscode.TabInputCustom) return a.uri.toString() === b.uri.toString() && a.viewType === b.viewType;
  return false;
}

export function findTab(group: vscode.TabGroup, matches: (input: unknown) => boolean): vscode.Tab | undefined {
  return group.activeTab && matches(group.activeTab.input) ? group.activeTab : group.tabs.find((tab) => matches(tab.input));
}

/** The file name of a document, for tab titles and log lines. */
export function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1) || uri.toString();
}
