import type { HierarchyNode, LspPosition, LspRange } from '../lsp/requests.js';

/**
 * The trees' own model of a hierarchy the server returned: every node wrapped
 * with its parent and a key unique within the tree. Pure — no editor API — so
 * the rules for matching, presenting and following are testable on their own.
 */
export interface ExplorerNode {
  /** Unique within one tree: the server `id`, suffixed only if the server repeats one. */
  readonly key: string;
  readonly node: HierarchyNode;
  readonly parent: ExplorerNode | undefined;
  readonly children: readonly ExplorerNode[];
  readonly depth: number;
}

export interface ExplorerTree {
  /** The document the hierarchy was asked for. */
  readonly documentUri: string;
  readonly roots: readonly ExplorerNode[];
  /** Every document a node of this hierarchy points at, the requested one included. */
  readonly sourceUris: ReadonlySet<string>;
  readonly size: number;
  /** Every node by its key. */
  readonly byKey: ReadonlyMap<string, ExplorerNode>;
}

export function buildTree(documentUri: string, nodes: readonly HierarchyNode[]): ExplorerTree {
  const seen = new Map<string, number>();
  const sourceUris = new Set<string>([documentUri]);
  const byKey = new Map<string, ExplorerNode>();
  let size = 0;
  const wrap = (node: HierarchyNode, parent: ExplorerNode | undefined, depth: number): ExplorerNode => {
    const base = typeof node.id === 'string' && node.id.length > 0 ? node.id : `${parent?.key ?? documentUri}/${node.kind}:${node.label}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    size++;
    if (typeof node.sourceUri === 'string' && node.sourceUri.length > 0) sourceUris.add(node.sourceUri);
    const children: ExplorerNode[] = [];
    const wrapped: ExplorerNode = { key: count === 0 ? base : `${base}~${count}`, node, parent, children, depth };
    byKey.set(wrapped.key, wrapped);
    for (const child of Array.isArray(node.children) ? node.children : []) children.push(wrap(child, wrapped, depth + 1));
    return wrapped;
  };
  const roots = nodes.map((node) => wrap(node, undefined, 0));
  return { documentUri, roots, sourceUris, size, byKey };
}

export function* walk(nodes: readonly ExplorerNode[]): Generator<ExplorerNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

export function findNode(tree: ExplorerTree, predicate: (node: ExplorerNode) => boolean): ExplorerNode | undefined {
  for (const node of walk(tree.roots)) if (predicate(node)) return node;
  return undefined;
}

function compare(a: LspPosition, b: LspPosition): number {
  return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

function contains(range: LspRange | undefined, position: LspPosition): boolean {
  return range !== undefined && compare(range.start, position) <= 0 && compare(position, range.end) <= 0;
}

function extent(range: LspRange): number {
  return (range.end.line - range.start.line) * 100000 + (range.end.character - range.start.character);
}

/**
 * The node standing for what is at a position of a document: the one with the
 * narrowest range that contains it; between equally narrow ranges the
 * shallowest, which is the declaration rather than a part repeated under it.
 */
export function nodeAt(tree: ExplorerTree, uri: string, position: LspPosition): ExplorerNode | undefined {
  let best: ExplorerNode | undefined;
  for (const candidate of walk(tree.roots)) {
    const { node } = candidate;
    if (node.sourceUri !== uri || !contains(node.sourceRange, position)) continue;
    if (!best) { best = candidate; continue; }
    const difference = extent(node.sourceRange) - extent(best.node.sourceRange);
    if (difference < 0 || (difference === 0 && candidate.depth < best.depth)) best = candidate;
  }
  return best;
}

/** Codicon per kind the client knows. A kind not listed gets {@link NEUTRAL_ICON}. */
const KIND_ICONS: Readonly<Record<string, string>> = {
  manifest: 'book',
  domain: 'symbol-namespace',
  subdomain: 'symbol-module',
  section: 'list-tree',
  document: 'file-code',
  system: 'server-environment',
  service: 'server-process',
  command: 'symbol-method',
  operation: 'symbol-method',
  event: 'symbol-event',
  message: 'mail',
  flow: 'type-hierarchy',
  start: 'debug-start',
  policy: 'zap',
  end: 'debug-stop',
  outcome: 'flag',
  entity: 'symbol-class',
  aggregate: 'symbol-structure',
  enum: 'symbol-enum',
  record: 'symbol-interface',
  field: 'symbol-field',
};

export const NEUTRAL_ICON = 'circle-small';

export interface NodePresentation {
  readonly label: string;
  readonly description?: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: string;
  readonly collapsible: boolean;
}

export function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name) || uri;
  } catch {
    return name || uri;
  }
}

const hint = (node: HierarchyNode, key: string): string | undefined => {
  const value = node.uiHints?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/**
 * How a node reads in a VS Code tree. The server's label is the default; this
 * client adapts it only for kinds whose server wording is structural rather
 * than a name (`section`, the `manifest` root), adds where a node is declared
 * when that is another document, and never drops a kind it does not know.
 */
export function presentNode(node: ExplorerNode, treeDocumentUri: string): NodePresentation {
  const { node: item } = node;
  const kind = typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : 'unknown';
  const serverLabel = typeof item.label === 'string' && item.label.length > 0 ? item.label : kind;
  let label = serverLabel;
  if (kind === 'section') label = serverLabel.charAt(0).toUpperCase() + serverLabel.slice(1);
  if (kind === 'manifest' && serverLabel === 'manifest' && item.sourceUri) label = fileName(item.sourceUri);

  const details: string[] = [];
  if (kind === 'policy' && hint(item, 'command')) details.push(`do ${hint(item, 'command')}`);
  const elsewhere = item.sourceUri && item.sourceUri !== treeDocumentUri ? fileName(item.sourceUri) : undefined;
  if (elsewhere) details.push(elsewhere);

  const related = Array.isArray(item.relatedResources) && item.relatedResources.length > 0;
  const tooltipLines = [`${kind} ${serverLabel}`];
  if (item.sourceUri) tooltipLines.push(`Declared in ${fileName(item.sourceUri)}${item.sourceRange ? `, line ${item.sourceRange.start.line + 1}` : ''}`);
  const events = hint(item, 'events');
  if (events) tooltipLines.push(`Emits ${events.split(',').join(', ')}`);
  if (related) tooltipLines.push(`${item.relatedResources.length} related resource${item.relatedResources.length === 1 ? '' : 's'}`);

  return {
    label,
    ...(details.length > 0 ? { description: details.join(' · ') } : {}),
    tooltip: tooltipLines.join('\n'),
    icon: KIND_ICONS[kind] ?? NEUTRAL_ICON,
    contextValue: `zenwave.hierarchy.${kind.replace(/[^A-Za-z0-9-]/g, '_')}${related ? '.related' : ''}`,
    collapsible: node.children.length > 0,
  };
}
