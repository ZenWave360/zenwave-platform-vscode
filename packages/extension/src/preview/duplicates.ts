/** A custom editor tab, reduced to what tells previews apart. `column` is the group's view column. */
export interface PreviewTabRef {
  readonly uri: string;
  readonly viewType: string;
  readonly column: number | undefined;
}

/** A preview editor, as the provider knows it. */
export interface PreviewPlace {
  readonly viewType: string;
  readonly column: number | undefined;
}

export interface DuplicatePreviewPorts<Tab extends PreviewTabRef> {
  /** Every custom editor tab that is open now. */
  tabs(): readonly Tab[];
  /** Shows the document's existing preview. It is not disposed or reloaded. */
  revealExisting(): void;
  close(tab: Tab): PromiseLike<unknown>;
}

/**
 * VS Code opens one custom editor per resource and view type, so a saved association and a command naming another view type
 * of the same document can both resolve (MP-R17: one preview per document). The new one is the tab with the new panel's
 * view type and column; failing that, any such tab that is not the existing preview. It is closed and the existing one is
 * shown. Returns whether a tab was closed.
 */
export async function closeDuplicatePreview<Tab extends PreviewTabRef>(
  uri: string,
  created: PreviewPlace,
  existing: PreviewPlace,
  ports: DuplicatePreviewPorts<Tab>,
): Promise<boolean> {
  const candidates = ports.tabs().filter((tab) => tab.uri === uri && tab.viewType === created.viewType);
  const isExisting = (tab: Tab): boolean => tab.viewType === existing.viewType && tab.column === existing.column;
  const duplicate = candidates.find((tab) => created.column !== undefined && tab.column === created.column && !isExisting(tab))
    ?? candidates.find((tab) => !isExisting(tab));
  if (!duplicate) return false;
  await ports.close(duplicate);
  ports.revealExisting();
  return true;
}
