import type { HierarchyNode, LspRange } from '../lsp/requests.js';
import type { TreeState } from './tree-state.js';

/** A local navigation range for an outline item; server hierarchy nodes do not need one. */
export interface OutlineHierarchyNode extends HierarchyNode {
  readonly revealRange?: LspRange;
}

export interface DocumentOutlineLoad {
  readonly nodes: readonly OutlineHierarchyNode[];
  readonly state: TreeState;
  readonly message?: string;
  /** A precise failure description for the extension output. */
  readonly log?: string;
}

/** The structural part of VS Code's `DocumentSymbol`, kept editor-API-free for unit tests. */
export interface DocumentSymbolLike {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange?: LspRange;
  readonly children?: readonly DocumentSymbolLike[];
}

/** The structural part of VS Code's `SymbolInformation`, which has no children. */
export interface SymbolInformationLike {
  readonly name: string;
  readonly containerName?: string;
  readonly kind: number;
  readonly location: { readonly uri: { toString(): string }; readonly range: LspRange };
}

export type DocumentOutlineSymbol = DocumentSymbolLike | SymbolInformationLike;

function isDocumentSymbol(symbol: DocumentOutlineSymbol): symbol is DocumentSymbolLike {
  return 'range' in symbol;
}

function node(
  symbol: DocumentOutlineSymbol,
  documentUri: string,
  path: string,
): OutlineHierarchyNode {
  if (isDocumentSymbol(symbol)) {
    const detail = symbol.detail?.trim();
    return {
      id: `outline:${path}`,
      label: symbol.name,
      kind: 'outline',
      sourceUri: documentUri,
      // The symbol covers its body, while selectionRange is only the name to reveal.
      sourceRange: symbol.range,
      ...(symbol.selectionRange ? { revealRange: symbol.selectionRange } : {}),
      children: (symbol.children ?? []).map((child, index) => node(child, documentUri, `${path}.${index}`)),
      relatedResources: [],
      uiHints: detail ? { detail } : {},
      viewNodeIds: [],
    };
  }

  const detail = symbol.containerName?.trim();
  return {
    id: `outline:${path}`,
    label: symbol.name,
    kind: 'outline',
    sourceUri: symbol.location.uri.toString(),
    sourceRange: symbol.location.range,
    children: [],
    relatedResources: [],
    uiHints: detail ? { detail } : {},
    viewNodeIds: [],
  };
}

/**
 * Converts either standard document-symbol response shape into the tree's
 * server-neutral node shape. `SymbolInformation` is inherently flat, so every
 * entry remains a root; `DocumentSymbol` preserves its nested outline.
 */
export function documentSymbolsToHierarchy(
  documentUri: string,
  symbols: readonly DocumentOutlineSymbol[] | undefined,
): readonly OutlineHierarchyNode[] {
  return (symbols ?? []).map((symbol, index) => node(symbol, documentUri, String(index)));
}

/** Asks a host provider for a document outline and turns provider failures into tree state. */
export async function loadDocumentOutline(
  documentUri: string,
  provide: () => Promise<readonly DocumentOutlineSymbol[] | undefined>,
): Promise<DocumentOutlineLoad> {
  try {
    const nodes = documentSymbolsToHierarchy(documentUri, await provide());
    // No TreeView message: `viewsWelcome` already says why an empty outline has no rows.
    return nodes.length > 0
      ? { nodes, state: { kind: 'ready', nodes: nodes.length } }
      : { nodes, state: { kind: 'outline-empty' } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      nodes: [],
      state: { kind: 'failed', reason },
      log: `document symbol provider failed for ${documentUri}: ${reason}`,
    };
  }
}
