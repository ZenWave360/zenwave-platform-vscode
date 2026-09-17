import * as vscode from 'vscode';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { openLocation, toLocation } from '../model/navigation.js';
import { CoalescedRefresh } from './coalesce.js';
import { DiagramPanels, reflectSelection, type SelectionReflection } from './diagram-selection.js';
import { followDecision, isModelDocument, tabDocumentUri } from './follow.js';
import { buildTree, fileName, nodeAt, presentNode, type ExplorerNode, type ExplorerTree } from './hierarchy-model.js';
import { describeState, sameState, serverUnavailable, stateFromResult, type TreeState } from './tree-state.js';

export const EXPLORER_VIEWS = {
  container: 'zenwave',
  architecture: 'zenwave.architecture',
  model: 'zenwave.model',
} as const;

export const EXPLORER_COMMANDS = {
  refresh: 'zenwave.explorer.refresh',
  openNode: 'zenwave.explorer.openNode',
  openRelated: 'zenwave.explorer.openRelated',
  openManifest: 'zenwave.explorer.openManifest',
} as const;

/** Why each tree shows what it shows (`TreeState['kind']`), for `viewsWelcome`. */
export const EXPLORER_CONTEXT_KEYS = {
  architectureTree: 'zenwave.architectureTreeState',
  modelTree: 'zenwave.modelTreeState',
} as const;

/** Quiet period after an edit before a tree asks the server again. */
const EDIT_DELAY_MS = 400;
/** A change of target or of server: soon, but still coalesced with its neighbours. */
const SWITCH_DELAY_MS = 50;
/** The cursor settles before the tree follows it. */
const REVEAL_DELAY_MS = 150;

export interface HierarchyTreeApi {
  readonly state: TreeState;
  /** The document whose hierarchy the tree shows or is about to show. */
  readonly documentUri: string | undefined;
  readonly tree: ExplorerTree | undefined;
  readonly view: vscode.TreeView<ExplorerNode>;
  readonly provider: vscode.TreeDataProvider<ExplorerNode>;
  /** `zenwave/hierarchy` requests issued so far, and tree updates published; for tests. */
  readonly stats: { readonly requests: number; readonly renders: number };
  /** Resolves when no refresh is scheduled or running. */
  settled(): Promise<void>;
  refresh(): void;
}

export interface ModelExplorerApi {
  readonly architecture: HierarchyTreeApi;
  readonly model: HierarchyTreeApi & { readonly lastReflection: SelectionReflection | undefined };
  /** Where a diagram editor registers so that tree selections highlight in it (004). */
  readonly diagramPanels: DiagramPanels;
}

export type OpenRelatedOutcome =
  | { readonly kind: 'opened'; readonly uri: string }
  | { readonly kind: 'none' | 'cancelled' };

interface Target {
  readonly uri?: string;
  /** Why there is nothing to ask about, when there is not. */
  readonly absent?: TreeState;
}

class HierarchyTree implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<ExplorerNode>;
  readonly refresher: CoalescedRefresh;
  tree: ExplorerTree | undefined;
  state: TreeState = { kind: 'loading' };
  target: Target = {};
  requests = 0;
  renders = 0;
  private generation = 0;
  private logged: { state: TreeState; uri: string | undefined } | undefined;

  constructor(
    private readonly name: string,
    viewId: string,
    private readonly contextKey: string,
    private readonly server: LanguageServerApi,
    private readonly logger: Logger,
    private readonly resolveTarget: () => Target,
    /** Called after every update, to add what the tree knows beyond the answer (the Model tree's problem note). */
    private readonly afterShow: () => void = () => undefined,
  ) {
    this.view = vscode.window.createTreeView(viewId, { treeDataProvider: this, showCollapseAll: true });
    this.refresher = new CoalescedRefresh(() => this.load(), EDIT_DELAY_MS);
    void this.publishState();
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    const presentation = presentNode(element, this.tree?.documentUri ?? '');
    const item = new vscode.TreeItem(presentation.label, presentation.collapsible
      ? element.depth < 2 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    item.id = element.key;
    if (presentation.description) item.description = presentation.description;
    item.tooltip = presentation.tooltip;
    item.iconPath = new vscode.ThemeIcon(presentation.icon);
    item.contextValue = presentation.contextValue;
    if (element.node.sourceUri) {
      item.command = { command: EXPLORER_COMMANDS.openNode, title: 'Go to Declaration', arguments: [element] };
    }
    return item;
  }

  getChildren(element?: ExplorerNode): ExplorerNode[] {
    return [...(element ? element.children : this.tree?.roots ?? [])];
  }

  getParent(element: ExplorerNode): ExplorerNode | undefined {
    // An element the view still holds from before a refresh answers with the current tree's parent.
    const current = this.tree?.byKey.get(element.key) ?? element;
    return current.parent;
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const unavailable = serverUnavailable(this.server.status, this.server.advertisedRequests);
    const target = this.resolveTarget();
    this.target = target;
    if (unavailable) return this.show(undefined, unavailable, target.uri);
    if (!target.uri) return this.show(undefined, target.absent ?? { kind: 'empty' }, undefined);

    this.requests++;
    const result = await this.server.requests.hierarchy(target.uri);
    // A newer load, or a new target, owns the tree now.
    if (generation !== this.generation || this.resolveTarget().uri !== target.uri) return;
    const tree = result.kind === 'ok' ? buildTree(target.uri, result.value) : undefined;
    const state = stateFromResult(result, tree?.size ?? 0);
    if (state.kind === 'unreadable' && this.tree?.documentUri === target.uri) {
      // Keep the last readable hierarchy of the same document rather than blanking it mid-edit.
      this.view.message = `${fileName(target.uri)} could not be read; showing its last readable hierarchy.`;
      return this.show(this.tree, state, target.uri);
    }
    this.view.message = '';
    return this.show(tree, state, target.uri);
  }

  private show(tree: ExplorerTree | undefined, state: TreeState, uri: string | undefined): void {
    this.tree = tree;
    this.state = state;
    if (tree === undefined) this.view.message = '';
    this.renders++;
    this.changed.fire(undefined);
    void this.publishState();
    const subject = uri ? fileName(uri) : undefined;
    const line = describeState(this.name, subject, state);
    if (this.logged && sameState(this.logged.state, state) && this.logged.uri === uri) {
      this.logger.debug(line);
    } else if (state.kind === 'ready' || state.kind === 'loading') {
      this.logger.info(line);
    } else {
      this.logger.warn(line);
    }
    this.logged = { state, uri };
    this.afterShow();
  }

  private async publishState(): Promise<void> {
    await vscode.commands.executeCommand('setContext', this.contextKey, this.state.kind);
  }

  dispose(): void {
    this.refresher.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}

function api(tree: HierarchyTree, documentUri: () => string | undefined): HierarchyTreeApi {
  return {
    get state() { return tree.state; },
    get documentUri() { return documentUri(); },
    get tree() { return tree.tree; },
    view: tree.view,
    provider: tree,
    get stats() { return { requests: tree.requests, renders: tree.renders }; },
    settled: () => tree.refresher.idle(),
    refresh: () => tree.refresher.request(SWITCH_DELAY_MS),
  };
}

export function registerModelExplorer(
  context: vscode.ExtensionContext,
  server: LanguageServerApi,
  logger: Logger,
): ModelExplorerApi {
  const diagramPanels = new DiagramPanels();

  // ── Architecture: the manifest 003 resolved, and nothing else ──────────────
  const architecture = new HierarchyTree('Architecture', EXPLORER_VIEWS.architecture, EXPLORER_CONTEXT_KEYS.architectureTree,
    server, logger, () => server.manifest.manifestUri
      ? { uri: server.manifest.manifestUri }
      : { absent: { kind: 'no-manifest' } });

  // ── Model: the model document the user is looking at ───────────────────────
  let shown: string | undefined;
  const model = new HierarchyTree('Model', EXPLORER_VIEWS.model, EXPLORER_CONTEXT_KEYS.modelTree,
    server, logger, () => shown ? { uri: shown } : { absent: { kind: 'no-model' } }, () => noteProblems());

  /**
   * A server may still build a hierarchy for a document with syntax errors. The tree
   * then shows what it got, and says that the document has errors, so a partial
   * hierarchy is not mistaken for the whole model.
   */
  function noteProblems(): void {
    if (model.state.kind !== 'ready' || !model.tree) return;
    const uri = model.tree.documentUri;
    const errors = vscode.languages.getDiagnostics(vscode.Uri.parse(uri, true))
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length;
    model.view.message = errors > 0
      ? `${fileName(uri)} has ${errors} error${errors === 1 ? '' : 's'}; its hierarchy may be incomplete.`
      : '';
  }
  let lastReflection: SelectionReflection | undefined;

  const openDocumentLanguage = (uri: string): string | undefined =>
    vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.languageId;

  function followActiveTab(): void {
    const uri = tabDocumentUri(vscode.window.tabGroups.activeTabGroup.activeTab?.input);
    const focused = uri && isModelDocument(uri, openDocumentLanguage(uri.toString())) ? uri.toString() : undefined;
    const current = model.tree?.documentUri === shown ? model.tree : undefined;
    if (followDecision(shown === undefined ? undefined : { uri: shown, ...(current ? { tree: current } : {}) }, focused) === 'keep') return;
    shown = focused;
    model.view.description = focused ? fileName(focused) : '';
    logger.debug(`Model tree follows ${focused}`);
    model.refresher.request(SWITCH_DELAY_MS);
  }

  /** Documents whose content can change what the Model tree shows. */
  const concernsModel = (uri: string): boolean => uri === shown || (model.tree?.sourceUris.has(uri) ?? false);
  const isManifest = (uri: string): boolean => uri === server.manifest.manifestUri;

  let manifestWatcher: vscode.FileSystemWatcher | undefined;
  let watchedManifest: string | undefined;
  function watchManifest(): void {
    const manifestUri = server.manifest.manifestUri;
    if (manifestUri === watchedManifest) return;
    manifestWatcher?.dispose();
    manifestWatcher = undefined;
    watchedManifest = manifestUri;
    architecture.view.description = manifestUri ? fileName(manifestUri) : '';
    if (!manifestUri) return;
    const uri = vscode.Uri.parse(manifestUri, true);
    const directory = vscode.Uri.joinPath(uri, '..');
    manifestWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, fileName(manifestUri)));
    const onDisk = (): void => architecture.refresher.request();
    manifestWatcher.onDidChange(onDisk);
    manifestWatcher.onDidCreate(onDisk);
    manifestWatcher.onDidDelete(onDisk);
  }

  function refreshAll(): void {
    watchManifest();
    architecture.refresher.request(SWITCH_DELAY_MS);
    model.refresher.request(SWITCH_DELAY_MS);
  }

  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Reveals the declaration under an editor's cursor. Runs once the cursor has
   * settled and the tree is not being refreshed, so a reveal never names nodes of
   * a tree that is being replaced.
   */
  async function revealCursor(editor: vscode.TextEditor): Promise<void> {
    await model.refresher.idle();
    const tree = model.tree;
    const uri = editor.document.uri.toString();
    if (!tree || !model.view.visible || !tree.sourceUris.has(uri)) return;
    const active = editor.selection.active;
    const node = nodeAt(tree, uri, { line: active.line, character: active.character });
    if (!node || model.view.selection[0]?.key === node.key) return;
    await model.view.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
  }

  async function openNode(element: unknown): Promise<string | undefined> {
    const node = (element as ExplorerNode | undefined)?.node;
    if (!node?.sourceUri) return undefined;
    const editor = await openLocation(toLocation({ uri: node.sourceUri, ...(node.sourceRange ? { range: node.sourceRange } : {}) }), { preserveFocus: true });
    return editor.document.uri.toString();
  }

  async function openRelated(element: unknown, choice?: unknown): Promise<OpenRelatedOutcome> {
    const resources = (element as ExplorerNode | undefined)?.node.relatedResources ?? [];
    if (resources.length === 0) {
      void vscode.window.showInformationMessage('The ZenWave language server reports no related resources for this node.');
      return { kind: 'none' };
    }
    let resource = typeof choice === 'number' ? resources[choice] : undefined;
    if (!resource && resources.length === 1) resource = resources[0];
    if (!resource) {
      const picked = await vscode.window.showQuickPick(resources.map((candidate) => ({
        label: candidate.label,
        description: candidate.relationType ?? candidate.targetKind,
        detail: fileName(candidate.uri),
        resource: candidate,
      })), { placeHolder: 'Open a related resource' });
      if (!picked) return { kind: 'cancelled' };
      resource = picked.resource;
    }
    const editor = await openLocation(toLocation(resource));
    return { kind: 'opened', uri: editor.document.uri.toString() };
  }

  async function openManifest(): Promise<boolean> {
    const manifestUri = server.manifest.manifestUri;
    if (!manifestUri) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'zenwave.workspace.manifest');
      return false;
    }
    await vscode.window.showTextDocument(vscode.Uri.parse(manifestUri, true), { preview: true });
    return true;
  }

  context.subscriptions.push(
    architecture,
    model,
    { dispose: () => manifestWatcher?.dispose() },
    server.onDidChange(() => refreshAll()),
    vscode.window.tabGroups.onDidChangeTabs(() => followActiveTab()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => followActiveTab()),
    vscode.workspace.onDidOpenTextDocument((document) => {
      const uri = document.uri.toString();
      if (isManifest(uri)) architecture.refresher.request();
      if (concernsModel(uri)) model.refresher.request();
      // A document opened before its tab settles: its language decides whether it is a model.
      followActiveTab();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      const uri = event.document.uri.toString();
      if (isManifest(uri)) architecture.refresher.request();
      if (concernsModel(uri)) model.refresher.request();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isManifest(document.uri.toString())) architecture.refresher.request();
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      if (model.tree && event.uris.some((uri) => uri.toString() === model.tree?.documentUri)) noteProblems();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!model.tree?.sourceUris.has(event.textEditor.document.uri.toString())) return;
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => { revealTimer = undefined; void revealCursor(event.textEditor); }, REVEAL_DELAY_MS);
    }),
    { dispose: () => { if (revealTimer !== undefined) clearTimeout(revealTimer); } },
    model.view.onDidChangeSelection((event) => {
      const selected = event.selection[0];
      void reflectSelection(diagramPanels, model.tree?.documentUri, selected ? selected.node.viewNodeIds ?? [] : undefined)
        .then((reflection) => { lastReflection = reflection; });
    }),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.refresh, () => refreshAll()),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openNode, openNode),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openRelated, openRelated),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openManifest, openManifest),
  );

  followActiveTab();
  refreshAll();

  const modelApi = Object.defineProperty(api(model, () => shown), 'lastReflection', { get: () => lastReflection, enumerable: true });
  return {
    architecture: api(architecture, () => server.manifest.manifestUri),
    model: modelApi as HierarchyTreeApi & { readonly lastReflection: SelectionReflection | undefined },
    diagramPanels,
  };
}
