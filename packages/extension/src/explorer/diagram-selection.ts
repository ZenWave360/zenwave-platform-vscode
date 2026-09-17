/**
 * The seam between the Model tree and an open diagram (004-eventflow-panel).
 *
 * The tree does not know how a diagram is hosted. A diagram editor registers a
 * panel for the document it shows and receives `highlightNode` calls; the page
 * message behind it is `004`'s (`highlightNode` with a node id, or `null` to
 * clear). Nothing here imports the editor API.
 */
export interface DiagramPanel {
  /** Highlight the view-model node with this id, or clear the highlight with `null`. */
  highlightNode(viewNodeId: string | null): void | PromiseLike<void>;
}

export interface Registration {
  dispose(): void;
}

/** Open diagram panels by the document URI (`uri.toString()`) whose view models they show. */
export class DiagramPanels {
  private readonly panels = new Map<string, Set<DiagramPanel>>();

  register(documentUri: string, panel: DiagramPanel): Registration {
    let set = this.panels.get(documentUri);
    if (!set) this.panels.set(documentUri, set = new Set());
    set.add(panel);
    return {
      dispose: () => {
        const current = this.panels.get(documentUri);
        current?.delete(panel);
        if (current?.size === 0) this.panels.delete(documentUri);
      },
    };
  }

  panelsFor(documentUri: string): readonly DiagramPanel[] {
    return [...(this.panels.get(documentUri) ?? [])];
  }
}

export type SelectionReflection = 'highlighted' | 'cleared' | 'no-diagram' | 'no-counterpart';

/**
 * Reflects a tree selection into the diagrams open for the tree's document.
 * A node without a counterpart clears the highlight rather than leaving the
 * previous one standing, which would point at the wrong concept. With no diagram
 * open nothing happens and nothing is reported.
 */
export async function reflectSelection(
  panels: DiagramPanels,
  documentUri: string | undefined,
  viewNodeIds: readonly string[] | undefined,
): Promise<SelectionReflection> {
  const open = documentUri === undefined ? [] : panels.panelsFor(documentUri);
  if (open.length === 0) return 'no-diagram';
  const id = viewNodeIds?.[0];
  await Promise.all(open.map(async (panel) => {
    try {
      await panel.highlightNode(id ?? null);
    } catch {
      // A panel that is closing cannot highlight; the others still do.
    }
  }));
  if (viewNodeIds === undefined) return 'cleared';
  return id === undefined ? 'no-counterpart' : 'highlighted';
}
