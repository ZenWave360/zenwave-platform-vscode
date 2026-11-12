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
  /** Where an outline item's name is, as distinct from the full range it contains. */
  readonly revealRange?: LspRange;
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
    const revealRange = (node as HierarchyNode & { readonly revealRange?: LspRange }).revealRange;
    const wrapped: ExplorerNode = { key: count === 0 ? base : `${base}~${count}`, node, parent, children, depth,
      ...(revealRange ? { revealRange } : {}) };
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
  if (range === undefined || compare(range.start, position) > 0) return false;
  // Ranges are half-open, so a boundary shared with the next outline symbol belongs to that symbol.
  // A zero-width range is a point — the server sends these — and still matches that point.
  return compare(range.start, range.end) === 0
    ? compare(position, range.end) === 0
    : compare(position, range.end) < 0;
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

/**
 * Codicon per kind the client knows. A kind not listed gets {@link NEUTRAL_ICON}.
 * Group nodes (`artifacts`, `docs`, `consumers`) are kinds the server sends, not a separate map.
 * `method` is the ZDL name for a service operation; ZFL and aggregates call the same thing `command`.
 */
const KIND_ICONS: Readonly<Record<string, string>> = {
  manifest: 'book',
  domain: 'globe',
  subdomain: 'folder-library',
  artifacts: 'library',
  docs: 'output',
  consumers: 'plug',
  artifact: 'file',
  doc: 'markdown',
  consumer: 'plug',
  section: 'list-tree',
  document: 'file-code',
  system: 'server-environment',
  service: 'server',
  command: 'symbol-method-arrow',
  method: 'symbol-method-arrow',
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
  api: 'symbol-interface',
  field: 'symbol-field',
};

const ARTIFACT_TYPE_ICONS: Readonly<Record<string, string>> = {
  openapi: 'symbol-interface',
  asyncapi: 'symbol-event',
  avro: 'symbol-structure',
  zdl: 'symbol-class',
  zfl: 'type-hierarchy',
};

export const NEUTRAL_ICON = 'circle-small';

export interface NodePresentation {
  readonly label: string;
  readonly description?: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly contextValue: string;
  readonly collapsible: boolean;
  /**
   * A file entry (ZDL, ZFL, OpenAPI or AsyncAPI YAML/JSON, Markdown). The tree
   * draws ThemeIcon.File from this path. Absent for folders, globs and
   * disabled entries, which keep the codicon and the disabled colour.
   */
  readonly fileResource?: string;
  /** A server-owned architecture resource address, if this entry can be opened. */
  readonly address?: string;
  /** An entry the server deliberately exposed but which this client must not open. */
  readonly disabled: boolean;
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

/** Extensions whose icon comes from the file icon theme, not a codicon. */
const FILE_ENTRY_EXTENSION = /\.(?:zdl|zfl|ya?ml|json|markdown|md)$/i;

function isFileEntryPath(value: string): boolean {
  if (value.includes('*') || value.endsWith('/') || value.endsWith('\\')) return false;
  return FILE_ENTRY_EXTENSION.test(fileName(value));
}

/**
 * The zenwave: address when its path is a file, otherwise the entry path.
 * Disabled entries are left out so they keep the greyed codicon.
 */
function fileEntryResource(item: HierarchyNode, disabled: boolean): string | undefined {
  if (disabled || (item.kind !== 'artifact' && item.kind !== 'doc')) return undefined;
  const address = typeof item.address === 'string' && item.address.length > 0 ? item.address : undefined;
  const label = typeof item.label === 'string' && item.label.length > 0 ? item.label : undefined;
  if (address && isFileEntryPath(address)) return address;
  if (label && isFileEntryPath(label)) return label;
  return undefined;
}

/**
 * Kinds that stand for a declaration in the hierarchies of `complete.zdl`,
 * `orders-checkout-api/domain-model.zdl` and `place-order-flow.zfl`.
 * A kind not listed is structural (`section`, `manifest`, `document`, `end`, `outcome`, `relationship`)
 * or not yet known, and gets no navigation button.
 */
const DECLARATION_KINDS = new Set([
  'aggregate', 'api', 'command', 'entity', 'enum', 'event', 'field',
  'flow', 'method', 'policy', 'service', 'start', 'system',
]);

/**
 * Kinds where a cursor on the name resolves to the hierarchy id (`@zenwave360/lsp-js` 0.1.0-next.13.1).
 * Entity, enum, aggregate, service and event names resolve to nothing; field and method names resolve to a neighbour.
 */
const REFERENCES_KINDS = new Set(['api', 'flow', 'system']);

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
  const outlineDetail = kind === 'outline' ? hint(item, 'detail') : undefined;
  if (outlineDetail) details.push(outlineDetail);
  if (kind === 'policy' && hint(item, 'command')) details.push(`do ${hint(item, 'command')}`);
  const isResource = kind === 'artifact' || kind === 'doc';
  const version = typeof item.version === 'string' && item.version.length > 0 ? item.version : undefined;
  const disabledReason = typeof item.disabledReason === 'string' && item.disabledReason.length > 0 ? item.disabledReason : undefined;
  const address = typeof item.address === 'string' && item.address.length > 0 ? item.address : undefined;
  // Manifest resource labels are paths (or an absolute URI). Preserve them as
  // the server gave them and repeat them in the compact path/version detail.
  if (isResource) {
    details.push(serverLabel);
    if (version) details.push(version);
    if (disabledReason) details.push('pending (phase 2)');
  }
  const elsewhere = item.sourceUri && item.sourceUri !== treeDocumentUri ? fileName(item.sourceUri) : undefined;
  if (elsewhere && !isResource) details.push(elsewhere);

  const related = Array.isArray(item.relatedResources) && item.relatedResources.length > 0;
  const tooltipLines = [`${kind} ${serverLabel}`];
  if (item.sourceUri) tooltipLines.push(`Declared in ${fileName(item.sourceUri)}${item.sourceRange ? `, line ${item.sourceRange.start.line + 1}` : ''}`);
  const events = hint(item, 'events');
  if (events) tooltipLines.push(`Emits ${events.split(',').join(', ')}`);
  if (related) tooltipLines.push(`${item.relatedResources.length} related resource${item.relatedResources.length === 1 ? '' : 's'}`);
  if (disabledReason) tooltipLines.push(`Pending (phase 2): ${disabledReason}`);

  // Named concepts a user can open. `service` and `event` also occur under a `policy` or an `outcome`,
  // where they repeat the parent's range and name a reference, not a declaration. `relationship` is a bucket.
  const parentKind = node.parent?.node.kind;
  const located = Boolean(item.sourceUri && item.sourceRange);
  const declaration = located && DECLARATION_KINDS.has(kind) && parentKind !== 'policy' && parentKind !== 'outcome';
  // Only these names resolve to the node's own id under a text cursor, so Go to References can ask for that id.
  const references = declaration && REFERENCES_KINDS.has(kind);
  const fileResource = fileEntryResource(item, disabledReason !== undefined);
  return {
    label,
    ...(details.length > 0 ? { description: details.join(' · ') } : {}),
    tooltip: tooltipLines.join('\n'),
    icon: kind === 'artifact'
      ? ARTIFACT_TYPE_ICONS[hint(item, 'type') ?? ''] ?? KIND_ICONS.artifact ?? NEUTRAL_ICON
      : KIND_ICONS[kind] ?? NEUTRAL_ICON,
    ...(fileResource ? { fileResource } : {}),
    contextValue: [
      `zenwave.hierarchy.${kind.replace(/[^A-Za-z0-9-]/g, '_')}`,
      related ? 'related' : '',
      declaration ? 'declaration' : '',
      references ? 'references' : '',
    ].filter((part) => part.length > 0).join('.'),
    collapsible: node.children.length > 0,
    ...(address && !disabledReason ? { address } : {}),
    disabled: disabledReason !== undefined,
  };
}

/**
 * What {@link TreeItem.iconPath} should be. `file` is `ThemeIcon.File`: the
 * icon theme matches {@link iconResourceUri}. A warning still wins, and a
 * disabled entry stays a greyed codicon.
 */
export type ItemIcon =
  | { readonly themeIcon: 'file'; readonly resource: string }
  | { readonly themeIcon: string; readonly disabled: boolean };

export function itemIcon(presentation: NodePresentation, warning: boolean): ItemIcon {
  if (warning) return { themeIcon: 'warning', disabled: presentation.disabled };
  if (presentation.fileResource) return { themeIcon: 'file', resource: presentation.fileResource };
  return { themeIcon: presentation.icon, disabled: presentation.disabled };
}

/**
 * A URI whose path ends with the file name, taken from the zenwave: address or
 * the entry path. The tree sets this as `resourceUri` for the icon theme only.
 * The item command is unchanged, so the URI is not opened.
 */
export function iconResourceUri(resource: string): { readonly scheme: string; readonly path: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(resource);
  if (!match) {
    const path = resource.replace(/\\/g, '/').replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
    return { scheme: 'file', path: `/${path}` };
  }
  const scheme = match[1]!.toLowerCase();
  let rest = match[2] ?? '';
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const query = rest.indexOf('?');
  if (query >= 0) rest = rest.slice(0, query);
  // `scheme://host/path` — drop the authority. `scheme:/path` and `scheme:///path` keep their path.
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    rest = slash >= 0 ? rest.slice(slash) : '/';
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return { scheme, path: rest };
}

export type Expansion = 'none' | 'collapsed' | 'expanded';
export type ExplorerTreeKind = 'architecture' | 'model';

/**
 * Named concepts whose children are fields. Listed, and collapsed, on the Model tree.
 * `enum`, `record` and `embedded` are the same shape when the server gives them children.
 */
const COLLAPSED_CONCEPTS = new Set(['entity', 'event', 'input', 'output', 'enum', 'record', 'embedded', 'field']);

/**
 * Initial twistie.
 *
 * Architecture keeps its first two depths open.
 * The Model tree does too, then applies the owner's exceptions: a service is
 * open so its commands show, and an entity, event, input, output or similar
 * concept is collapsed so its fields stay hidden. A field with children is
 * collapsed; a field with none is a leaf. The server sends field children for
 * entities only. Events in the recorded hierarchies have none, and inputs and
 * outputs are not in the hierarchy at all, so those kinds collapse only when
 * a node of that kind actually has children.
 */
export function initialExpansion(node: ExplorerNode, tree: ExplorerTreeKind): Expansion {
  if (node.children.length === 0) return 'none';
  if (tree === 'model') {
    if (node.node.kind === 'service') return 'expanded';
    if (COLLAPSED_CONCEPTS.has(node.node.kind)) return 'collapsed';
  }
  return node.depth < 2 ? 'expanded' : 'collapsed';
}

/** Root first. `TreeView.reveal` opens this chain so a collapsed parent does not hide the node. */
export function ancestorChain(node: ExplorerNode): readonly ExplorerNode[] {
  const chain: ExplorerNode[] = [];
  for (let current = node.parent; current; current = current.parent) chain.unshift(current);
  return chain;
}

/**
 * Options for the Model tree's cursor reveal. `expand` opens the node in focus;
 * reveal opens {@link ancestorChain} through `getParent`.
 */
export const CURSOR_REVEAL = { select: true, focus: false, expand: true } as const;
