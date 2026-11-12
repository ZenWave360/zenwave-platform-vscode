import * as vscode from 'vscode';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { manifestDocument } from '../lsp/manifest.js';
import { isRemoteManifest } from '../lsp/manifest-resolution.js';
import { openLocation, toLocation } from '../model/navigation.js';
import { CoalescedRefresh } from './coalesce.js';
import { loadDocumentOutline, type DocumentOutlineSymbol } from './document-symbols.js';
import { DiagramPanels, reflectSelection, type SelectionReflection } from './diagram-selection.js';
import { focusedTreeTarget, followDecision, outlineRetarget, tabDocumentUri, targetForTextDocument, type FocusedTab, type ModelTreeSource, type OutlineKind, type TextDocumentTarget } from './follow.js';
import { buildTree, fileName, nodeAt, presentNode, type ExplorerNode, type ExplorerTree } from './hierarchy-model.js';
import { describeState, sameState, serverUnavailable, stateFromResult, type TreeState } from './tree-state.js';
import { LatestLoad } from './latest-load.js';

export const EXPLORER_VIEWS = {
  container: 'zenwave',
  architecture: 'zenwave.architecture',
  model: 'zenwave.model',
} as const;

export const EXPLORER_COMMANDS = {
  refresh: 'zenwave.explorer.refresh',
  openNode: 'zenwave.explorer.openNode',
  openResource: 'zenwave.explorer.openResource',
  goToDefinition: 'zenwave.explorer.goToDefinition',
  goToReferences: 'zenwave.explorer.goToReferences',
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
/**
 * How long to wait for a host outline. The Markdown provider in the web host can
 * fail to answer; the tree still has to leave the previous model.
 */
const OUTLINE_WAIT_MS = 15000;

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
  /** Which service supplies this tree. Architecture and ZenWave models use the server. */
  readonly source?: ModelTreeSource;
  /** Needed only to activate Markdown's outline provider on first use. */
  readonly outlineKind?: OutlineKind;
  /** Why there is nothing to ask about, when there is not. */
  readonly absent?: TreeState;
}

interface TreeLoad {
  readonly tree: ExplorerTree | undefined;
  readonly state: TreeState;
  /** A banner `viewsWelcome` does not already show. An empty outline leaves this unset. */
  readonly message?: string;
  /** More precise than the generic state description when a non-server provider failed. */
  readonly log?: string;
}

const sameTarget = (left: Target, right: Target): boolean =>
  left.uri === right.uri && left.source === right.source && left.outlineKind === right.outlineKind && left.absent?.kind === right.absent?.kind;

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
  private readonly latestLoad = new LatestLoad<Target, TreeLoad>();
  private logged: { state: TreeState; uri: string | undefined } | undefined;
  /** Resource-open failures survive tree rendering until the user explicitly refreshes. */
  private readonly openWarnings = new Map<string, string>();

  constructor(
    private readonly name: string,
    viewId: string,
    private readonly contextKey: string,
    private readonly server: LanguageServerApi,
    private readonly logger: Logger,
    private readonly resolveTarget: () => Target,
    private readonly loadTarget: (target: Target) => Promise<TreeLoad>,
    private readonly unavailable: (target: Target) => TreeState | undefined,
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
    const warning = this.openWarnings.get(element.key);
    item.tooltip = warning ? `${presentation.tooltip}\n\nWarning: ${warning}` : presentation.tooltip;
    item.iconPath = new vscode.ThemeIcon(warning ? 'warning' : presentation.icon,
      presentation.disabled ? new vscode.ThemeColor('disabledForeground') : undefined);
    item.contextValue = presentation.contextValue;
    if (presentation.address) {
      item.command = { command: EXPLORER_COMMANDS.openResource, title: 'Open Architecture Resource', arguments: [element] };
    } else if (element.node.kind !== 'artifact' && element.node.kind !== 'doc' && element.node.kind !== 'consumer' && element.node.sourceUri) {
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

  /** The title-bar refresh deliberately clears resource warnings before re-asking the hierarchy. */
  manualRefresh(): void {
    this.openWarnings.clear();
    this.changed.fire(undefined);
    this.refresher.request(SWITCH_DELAY_MS);
  }

  async openResource(element: unknown): Promise<void> {
    const explorerNode = element as ExplorerNode | undefined;
    const presentation = explorerNode ? presentNode(explorerNode, this.tree?.documentUri ?? '') : undefined;
    if (!explorerNode || !presentation?.address) return;
    const outcome = await this.server.openResource(presentation.address);
    if (outcome.kind === 'opened') return;
    this.openWarnings.set(explorerNode.key, outcome.message);
    this.changed.fire(explorerNode);
  }

  private async load(): Promise<void> {
    const current = await this.latestLoad.run(this.resolveTarget, async (target) => {
      const unavailable = this.unavailable(target);
      if (unavailable) return { tree: undefined, state: unavailable };
      if (!target.uri) return { tree: undefined, state: target.absent ?? { kind: 'empty' } };
      if (target.source !== 'outline') this.requests++;
      return this.loadTarget(target);
    }, sameTarget);
    // A newer load, or a new target, owns the tree now.
    if (!current) return;
    const { target, result: loaded } = current;
    this.target = target;
    const { tree, state } = loaded;
    if (target.uri && state.kind === 'unreadable' && this.tree?.documentUri === target.uri) {
      // Keep the last readable hierarchy of the same document rather than blanking it mid-edit.
      this.view.message = `${fileName(target.uri)} could not be read; showing its last readable hierarchy.`;
      return this.show(this.tree, state, target.uri);
    }
    // A successful hierarchy replaces an unreadable banner from a prior attempt.
    if (tree !== undefined && loaded.message === undefined) this.view.message = '';
    return this.show(tree, state, target.uri, loaded.message, loaded.log);
  }

  private show(tree: ExplorerTree | undefined, state: TreeState, uri: string | undefined, message?: string, log?: string): void {
    this.tree = tree;
    this.state = state;
    if (message !== undefined || tree === undefined) this.view.message = message ?? '';
    this.renders++;
    this.changed.fire(undefined);
    void this.publishState();
    const subject = uri ? fileName(uri) : undefined;
    const line = log ?? describeState(this.name, subject, state);
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
    refresh: () => tree.manualRefresh(),
  };
}

export function registerModelExplorer(
  context: vscode.ExtensionContext,
  server: LanguageServerApi,
  logger: Logger,
): ModelExplorerApi {
  const diagramPanels = new DiagramPanels();

  const loadServerHierarchy = async (target: Target): Promise<TreeLoad> => {
    if (!target.uri) return { tree: undefined, state: target.absent ?? { kind: 'empty' } };
    const result = await server.requests.hierarchy(target.uri);
    const tree = result.kind === 'ok' ? buildTree(target.uri, result.value) : undefined;
    return { tree, state: stateFromResult(result, tree?.size ?? 0) };
  };
  const serverUnavailableFor = (target: Target): TreeState | undefined =>
    target.source === 'outline' ? undefined : serverUnavailable(server.status, server.advertisedRequests);
  const loadModelTree = async (target: Target): Promise<TreeLoad> => {
    if (target.source !== 'outline') return loadServerHierarchy(target);
    if (!target.uri) return { tree: undefined, state: target.absent ?? { kind: 'empty' } };
    const uri = target.uri;
    const ask = () => symbolsWithin(vscode.commands.executeCommand<readonly DocumentOutlineSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider', vscode.Uri.parse(uri, true),
    ), OUTLINE_WAIT_MS, () => logger.warn(`Document symbol provider did not answer for ${fileName(uri)} within ${OUTLINE_WAIT_MS}ms`));
    let outline = await loadDocumentOutline(uri, ask);
    // The built-in Markdown extension can be inactive when the first focused
    // Markdown document arrives. Activate it once, then ask its provider again.
    // A failure here must not abandon the load: an empty answer still replaces
    // the previous model, and `viewsWelcome` explains the empty outline.
    if (target.outlineKind === 'markdown' && outline.state.kind === 'outline-empty') {
      const markdown = vscode.extensions.getExtension('vscode.markdown-language-features');
      if (markdown && !markdown.isActive) {
        try {
          await deadline(markdown.activate(), OUTLINE_WAIT_MS);
          outline = await loadDocumentOutline(uri, ask);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn(`Markdown outline provider did not activate for ${fileName(uri)}: ${reason}`);
        }
      }
    }
    const tree = outline.nodes.length > 0 ? buildTree(uri, outline.nodes) : undefined;
    return tree
      ? { tree, state: { kind: 'ready', nodes: tree.size }, ...(outline.log ? { log: outline.log } : {}) }
      : { tree: undefined, state: outline.state, ...(outline.message ? { message: outline.message } : {}), ...(outline.log ? { log: outline.log } : {}) };
  };

  // ── Architecture: the manifest 003 resolved, and nothing else ──────────────
  const architecture = new HierarchyTree('Architecture', EXPLORER_VIEWS.architecture, EXPLORER_CONTEXT_KEYS.architectureTree,
    server, logger, () => server.manifest.manifestUri
      ? { uri: server.manifest.manifestUri }
      : { absent: { kind: 'no-manifest' } }, loadServerHierarchy, serverUnavailableFor);

  // ── Model: the model document the user is looking at ───────────────────────
  let shown: Target | undefined;
  const model = new HierarchyTree('Model', EXPLORER_VIEWS.model, EXPLORER_CONTEXT_KEYS.modelTree,
    server, logger, () => shown ?? { absent: { kind: 'no-model' } }, loadModelTree, serverUnavailableFor, () => noteProblems());

  /**
   * A server may still build a hierarchy for a document with syntax errors. The tree
   * then shows what it got, and says that the document has errors, so a partial
   * hierarchy is not mistaken for the whole model.
   */
  function noteProblems(): void {
    if (shown?.source === 'outline') return;
    if (model.state.kind !== 'ready' || !model.tree) return;
    const uri = model.tree.documentUri;
    const errors = vscode.languages.getDiagnostics(vscode.Uri.parse(uri, true))
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length;
    model.view.message = errors > 0
      ? `${fileName(uri)} has ${errors} error${errors === 1 ? '' : 's'}; its hierarchy may be incomplete.`
      : '';
  }
  let lastReflection: SelectionReflection | undefined;

  /** Reads only enough of a structured document to identify an API description. */
  const outlineProbe = (document: vscode.TextDocument): string => {
    const lastLine = Math.min(document.lineCount - 1, 49);
    const end = document.lineAt(lastLine).range.end;
    return document.getText(new vscode.Range(0, 0, end.line, end.character)).slice(0, 4 * 1024);
  };

  /**
   * The active tab, including one that holds no model document. A webview has no
   * uri; it is still the focus, so the text editor in another group is not used.
   */
  function describeFocusedTab(input: unknown): FocusedTab {
    const uri = tabDocumentUri(input);
    if (uri && isPlainTextTab(input)) {
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
      return document
        ? { uri, customEditor: false, languageId: document.languageId, text: outlineProbe(document) }
        : { uri, customEditor: false };
    }
    if (!uri) return { customEditor: true };
    const languageId = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.languageId;
    return languageId !== undefined ? { uri, customEditor: true, languageId } : { uri, customEditor: true };
  }

  function followActiveDocument(): void {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const textEditor = vscode.window.activeTextEditor;
    // The text editor is the fallback only when the editor reported no active tab.
    // A diagram, image or webview is the focus even while a text editor stays
    // active in another group.
    const textTarget = !activeTab && textEditor
      ? targetForTextDocument(textEditor.document.uri, textEditor.document.languageId, outlineProbe(textEditor.document))
      : undefined;
    const next = focusedTreeTarget(textTarget, activeTab ? describeFocusedTab(activeTab.input) : undefined);
    if (!next) return;
    adoptTreeTarget(next);
  }

  function adoptTreeTarget(next: TextDocumentTarget): void {
    const focused: Target = { uri: next.uri, source: next.source, ...(next.outlineKind ? { outlineKind: next.outlineKind } : {}) };

    if (focused.source === 'server') {
      const current = model.tree?.documentUri === shown?.uri ? model.tree : undefined;
      const currentModel = shown?.source === 'server' ? { uri: shown.uri!, ...(current ? { tree: current } : {}) } : undefined;
      if (followDecision(currentModel, focused.uri) === 'keep') return;
    } else if (shown?.uri === focused.uri && shown?.source === focused.source) {
      return;
    }

    shown = focused;
    model.view.description = fileName(focused.uri!);
    logger.debug(`Model tree follows ${focused.uri} from ${focused.source}`);
    model.refresher.request(SWITCH_DELAY_MS);
  }

  /**
   * The document the user is editing. A text tab is that tab's document. The
   * active text editor counts only when no tab is reported: a diagram or image
   * can leave a text editor active in another group.
   */
  function isActiveTextDocument(document: vscode.TextDocument): boolean {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) return false;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab) return true;
    if (!isPlainTextTab(activeTab.input)) return false;
    return tabDocumentUri(activeTab.input)?.toString() === document.uri.toString();
  }

  let outlineEditTimer: ReturnType<typeof setTimeout> | undefined;
  let outlineEditDocument: vscode.TextDocument | undefined;
  /** Re-reads the active document's discriminator once edits have gone quiet. */
  function scheduleOutlineRecheck(document: vscode.TextDocument): void {
    outlineEditDocument = document;
    if (outlineEditTimer !== undefined) clearTimeout(outlineEditTimer);
    outlineEditTimer = setTimeout(() => {
      outlineEditTimer = undefined;
      const edited = outlineEditDocument;
      outlineEditDocument = undefined;
      if (!edited || !isActiveTextDocument(edited)) return;
      const current = shown?.uri && shown.source ? { uri: shown.uri, source: shown.source } : undefined;
      const next = outlineRetarget(current, {
        active: true,
        uri: edited.uri,
        languageId: edited.languageId,
        text: outlineProbe(edited),
      });
      if (next) adoptTreeTarget(next);
    }, EDIT_DELAY_MS);
  }

  /** Documents whose content can change what the Model tree shows. */
  const concernsModel = (uri: string): boolean => uri === shown?.uri || (shown?.source === 'server' && (model.tree?.sourceUris.has(uri) ?? false));
  const isManifest = (uri: string): boolean => uri === manifestDocument(server.manifest)?.toString();

  let manifestWatcher: vscode.FileSystemWatcher | undefined;
  let watchedManifest: string | undefined;
  function watchManifest(): void {
    const manifestUri = server.manifest.manifestUri;
    if (manifestUri === watchedManifest) return;
    manifestWatcher?.dispose();
    manifestWatcher = undefined;
    watchedManifest = manifestUri;
    architecture.view.description = manifestUri ? fileName(manifestUri) : '';
    // An http(s) manifest has nothing on disk to watch; the server re-reads it on a restart.
    if (!manifestUri || isRemoteManifest(manifestUri)) return;
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

  function manualRefreshAll(): void {
    watchManifest();
    architecture.manualRefresh();
    model.manualRefresh();
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
    const elementNode = element as ExplorerNode | undefined;
    const node = elementNode?.node;
    if (!node?.sourceUri) return undefined;
    const range = elementNode?.revealRange ?? node.sourceRange;
    const editor = await openLocation(toLocation({ uri: node.sourceUri, ...(range ? { range } : {}) }), { preserveFocus: true });
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
    const document = manifestDocument(server.manifest);
    if (!document) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'zenwave.workspace.manifest');
      return false;
    }
    await vscode.window.showTextDocument(document, { preview: true });
    return true;
  }

  context.subscriptions.push(
    architecture,
    model,
    { dispose: () => manifestWatcher?.dispose() },
    server.onDidChange(() => refreshAll()),
    vscode.window.tabGroups.onDidChangeTabs(() => followActiveDocument()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => followActiveDocument()),
    vscode.window.onDidChangeActiveTextEditor(() => followActiveDocument()),
    vscode.workspace.onDidOpenTextDocument((document) => {
      const uri = document.uri.toString();
      if (isManifest(uri)) architecture.refresher.request();
      if (concernsModel(uri)) model.refresher.request();
      // A document opened before its tab settles: its language decides whether it is a model.
      followActiveDocument();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      const uri = event.document.uri.toString();
      if (isManifest(uri)) architecture.refresher.request();
      if (concernsModel(uri)) model.refresher.request();
      // An ordinary YAML or JSON file can become an API description as it is typed.
      // The discriminator is the bounded prefix; the tree moves only when it qualifies.
      if (isActiveTextDocument(event.document)) scheduleOutlineRecheck(event.document);
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
    { dispose: () => {
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      if (outlineEditTimer !== undefined) clearTimeout(outlineEditTimer);
    } },
    model.view.onDidChangeSelection((event) => {
      const selected = event.selection[0];
      void reflectSelection(diagramPanels, model.tree?.documentUri, selected ? selected.node.viewNodeIds ?? [] : undefined)
        .then((reflection) => { lastReflection = reflection; });
    }),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.refresh, () => manualRefreshAll()),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openNode, openNode),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openResource, (element: unknown) => architecture.openResource(element)),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.goToDefinition, openNode),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.goToReferences, (element: unknown) => {
      const item = (element as ExplorerNode | undefined)?.node;
      // The hierarchy id is the semantic id. A position in the declaration is not: symbolAt there is null or a neighbour.
      if (!item?.sourceUri || !item.id.includes('#')) return undefined;
      return vscode.commands.executeCommand('zenwave.model.reverseReferences', vscode.Uri.parse(item.sourceUri, true), item.sourceRange?.start, item.id);
    }),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openRelated, openRelated),
    vscode.commands.registerCommand(EXPLORER_COMMANDS.openManifest, openManifest),
  );

  followActiveDocument();
  refreshAll();

  const modelApi = Object.defineProperty(api(model, () => shown?.uri), 'lastReflection', { get: () => lastReflection, enumerable: true });
  return {
    architecture: api(architecture, () => server.manifest.manifestUri),
    model: modelApi as HierarchyTreeApi & { readonly lastReflection: SelectionReflection | undefined },
    diagramPanels,
  };
}

/**
 * Waits for a host outline. A provider that does not answer yields no symbols, so the
 * tree can leave the previous model; a provider that rejects still fails the load.
 * A late answer after the wait is ignored, including a late rejection.
 */
function symbolsWithin<T>(pending: PromiseLike<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<T | undefined>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      resolve(undefined);
    }, ms);
    Promise.resolve(pending).then(
      (value) => { if (!timedOut) resolve(value); },
      (error: unknown) => { if (!timedOut) reject(error); },
    );
  });
  return result.finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Rejects when `pending` does not settle in time. A late rejection afterwards is ignored. */
function deadline<T>(pending: PromiseLike<T>, ms: number): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(pending).then(
      (value) => { if (!settled) { settled = true; resolve(value); } },
      (error: unknown) => { if (!settled) { settled = true; reject(error); } },
    );
  });
  return result.finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** `TabInputText`: one document uri, and none of the fields a custom editor, webview, diff or notebook carries. */
function isPlainTextTab(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  if ('viewType' in input || 'notebookType' in input || 'original' in input || 'modified' in input) return false;
  return tabDocumentUri(input) !== undefined;
}
