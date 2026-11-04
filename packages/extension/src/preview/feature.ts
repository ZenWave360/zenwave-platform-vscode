import * as vscode from 'vscode';
import { CoalescedRefresh } from '../explorer/coalesce.js';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { commandDocument, isPreviewableDocument, isZdlDocument, isZflDocument } from '../model/active-document.js';
import { fileName, findTab, replaceInPlace } from '../model/editor-tabs.js';
import { createNonce } from '../eventflow/page.js';
import { buildFailedHtml, buildPreviewHtml } from './page.js';
import { decidePreviewLink } from './links.js';
import type { PreviewMode } from '../lsp/requests.js';
import { FOLLOWING_VIEW_TYPE, PREVIEW_VIEW_TYPE, RENDER_MODES, inboundMessage, isRenderMode, type PreviewProbe, type RenderMode } from './protocol.js';
import { PREVIEW_MARKDOWN_CONTEXT_KEY, PreviewSession, markdownContextValue } from './session.js';
import { FollowingMemory, followTarget, followingTitle, followsLanguage, isFollowingViewType } from './following.js';

export const PREVIEW_COMMANDS = {
  open: 'zenwave.preview.open',
  openToSide: 'zenwave.preview.openToSide',
  openSequenceDiagrams: 'zenwave.preview.openSequenceDiagrams',
  openModelDocs: 'zenwave.preview.openModelDocs',
  openZdlDiagrams: 'zenwave.preview.openZdlDiagrams',
  openScriptsDocs: 'zenwave.preview.openScriptsDocs',
  openSequenceDiagramsToSide: 'zenwave.preview.openSequenceDiagramsToSide',
  openModelDocsToSide: 'zenwave.preview.openModelDocsToSide',
  openScriptsDocsToSide: 'zenwave.preview.openScriptsDocsToSide',
  showText: 'zenwave.preview.showText',
  selectDiagram: 'zenwave.preview.selectDiagram',
  selectRenderMode: 'zenwave.preview.selectRenderMode',
  copyMarkdown: 'zenwave.preview.copyMarkdown',
  openFollowing: 'zenwave.preview.openFollowing',
  lockFollowing: 'zenwave.preview.lockFollowing',
} as const;


/** Where the page, its stylesheet and the Mermaid bundle are put by the build (esbuild.mjs). */
const PAGE_DIRECTORY = ['dist', 'preview-webview'] as const;
/** A burst of keystrokes is one request once typing pauses this long. */
export const EDIT_DELAY_MS = 300;
const SWITCH_DELAY_MS = 50;
/** How long a requested mode waits for an editor that has not been created yet. */
const PENDING_MODE_MS = 5000;
/** How long a visible page may take to say it loaded before the editor calls it a failure. */
const PAGE_LOAD_SECONDS = 30;

export type PreviewOpenOutcome =
  | { readonly kind: 'opened'; readonly documentUri: string }
  | { readonly kind: 'no-document' }
  | { readonly kind: 'untitled' };

export type PreviewSelectOutcome =
  | { readonly kind: 'selected'; readonly value: string }
  | { readonly kind: 'cancelled' | 'no-preview' | 'unavailable' };

export interface PreviewEditorApi {
  readonly documentUri: string;
  readonly panel: vscode.WebviewPanel;
  readonly session: PreviewSession;
  /** Resolves when no request is scheduled or running. */
  settled(): Promise<void>;
  probe(followLink?: string, copyMermaid?: number): Promise<PreviewProbe>;
}

export interface PreviewApi {
  readonly editors: readonly PreviewEditorApi[];
  /** The following preview of this window, if open (MP-R31). It is not among `editors`: those are of one document each. */
  readonly following: PreviewEditorApi | undefined;
  editorsFor(documentUri: string): readonly PreviewEditorApi[];
  /** The preview with focus, if any. */
  readonly active: PreviewEditorApi | undefined;
}

function hasRenderMode(uri: vscode.Uri): boolean {
  const languageId = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.languageId;
  return isZflDocument(uri, languageId);
}

function hasDiagrams(uri: vscode.Uri): boolean {
  const languageId = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.languageId;
  return isZdlDocument(uri, languageId);
}

class PreviewEditor implements PreviewEditorApi, vscode.Disposable {
  documentUri: string;
  session: PreviewSession;
  private readonly refresher: CoalescedRefresh;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher: vscode.Disposable[] = [];
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private failedShown = false;
  private disposed = false;
  /** Holds the document open as text, so the language server has it even when no text editor shows it. */
  textDocument: vscode.TextDocument | undefined;

  constructor(
    private uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly deps: { readonly memory?: FollowingMemory<PreviewSession>; readonly context: vscode.ExtensionContext; readonly server: LanguageServerApi; readonly logger: Logger; readonly onDispose: (editor: PreviewEditor) => void; readonly onFocus: (editor: PreviewEditor) => void; readonly onContextChange: () => void; readonly initialMode: (documentUri: string) => PreviewMode },
  ) {
    this.documentUri = uri.toString();
    const webview = panel.webview;
    const pageDirectory = vscode.Uri.joinPath(deps.context.extensionUri, ...PAGE_DIRECTORY);
    webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [pageDirectory] };
    this.session = this.sessionFor(uri);
    this.refresher = new CoalescedRefresh(() => this.session.refresh(), EDIT_DELAY_MS);

    this.subscriptions.push(
      webview.onDidReceiveMessage((message) => this.receive(message)),
      panel.onDidChangeViewState(() => this.viewStateChanged()),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.documentUri && event.contentChanges.length > 0) this.refresher.request();
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.toString() === this.documentUri) this.refresher.request(SWITCH_DELAY_MS);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === this.documentUri && !this.disposed) void this.keepOpen();
      }),
      deps.server.onDidChange(() => this.refresher.request(SWITCH_DELAY_MS)),
    );
    this.watchFile();

    this.load(webview, pageDirectory);
    void this.keepOpen().then(() => this.refresher.request(SWITCH_DELAY_MS));
    this.viewStateChanged();
  }

  /** The session of a document: the remembered one for a following preview (MP-R31), a new one otherwise. */
  private sessionFor(uri: vscode.Uri): PreviewSession {
    const create = (): PreviewSession => {
      // Held outside the session: it posts its first state from its constructor, before `new` returns.
      const built: { session?: PreviewSession } = {};
      const session = new PreviewSession({
        documentUri: uri.toString(),
        fileName: fileName(uri),
        hasRenderMode: hasRenderMode(uri),
        preview: (target, renderMode, mode) => this.deps.server.requests.preview(target, renderMode, mode),
        diagramsAvailable: () => hasDiagrams(uri) && this.deps.server.previewModes,
        // A session that is not the one on screen, or a panel that is gone, has nobody to tell. While the editor's first
        // session is being built there is no other on screen, so its first state goes out as it did before MP-R31.
        post: (message) => this.disposed || (this.session !== undefined && this.session !== built.session) ? Promise.resolve(false) : this.panel.webview.postMessage(message),
        runCommand: (command) => { void vscode.commands.executeCommand(command); },
        setContext: () => this.publishContext(),
        log: this.deps.logger,
      });
      built.session = session;
      session.requestedMode = this.deps.initialMode(uri.toString());
      return session;
    };
    return this.deps.memory ? this.deps.memory.recall(uri.toString(), create) : create();
  }

  /**
   * A change on disk (a branch switch, another tool) reaches an open text document as a change event; the
   * watcher covers a document whose text model VS Code has not loaded yet.
   */
  private watchFile(): void {
    for (const item of this.watcher) item.dispose();
    this.watcher = [];
    const uri = this.uri;
    if (uri.scheme === 'file' || uri.scheme === 'vscode-vfs' || uri.scheme === 'vscode-test-web') {
      const directory = vscode.Uri.joinPath(uri, '..');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, fileName(uri)));
      this.watcher = [watcher, watcher.onDidChange(() => this.refresher.request()), watcher.onDidCreate(() => this.refresher.request())];
    }
  }

  /** The following preview moves to another document (MP-R31): its session is the file's own, so mode, diagram and scroll come back. */
  showDocument(uri: vscode.Uri): void {
    if (this.disposed || uri.toString() === this.documentUri) return;
    const page = this.session.page;
    this.uri = uri;
    this.documentUri = uri.toString();
    this.session = this.sessionFor(uri);
    this.panel.title = followingTitle(fileName(uri));
    this.watchFile();
    this.session.attach(page);
    void this.keepOpen().then(() => this.refresher.request(SWITCH_DELAY_MS));
    this.deps.onContextChange();
  }

  private resources(webview: vscode.Webview, pageDirectory: vscode.Uri): { cspSource: string; nonce: string; scriptUri: string; styleUri: string; mermaidUri: string; contentUri: string } {
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(pageDirectory, name)).toString();
    return { cspSource: webview.cspSource, nonce: createNonce(), scriptUri: asset('preview.js'), styleUri: asset('preview.css'), mermaidUri: asset('mermaid.min.js'), contentUri: asset('content.js') };
  }

  private load(webview: vscode.Webview, pageDirectory: vscode.Uri): void {
    webview.html = buildPreviewHtml(this.resources(webview, pageDirectory));
    this.startLoadTimer();
  }

  private startLoadTimer(): void {
    if (this.loadTimer !== undefined || this.session.page.kind !== 'loading' || !this.panel.visible) return;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      if (this.panel.visible) {
        this.session.pageTimedOut(PAGE_LOAD_SECONDS);
        this.showFailedPage();
      }
    }, PAGE_LOAD_SECONDS * 1000);
  }

  /** When the page cannot run, nothing in it can explain: replace it with a static page that does. */
  private showFailedPage(): void {
    const page = this.session.page;
    if (page.kind !== 'failed' || this.failedShown || this.disposed) return;
    this.failedShown = true;
    const webview = this.panel.webview;
    const pageDirectory = vscode.Uri.joinPath(this.deps.context.extensionUri, ...PAGE_DIRECTORY);
    webview.html = buildFailedHtml(this.resources(webview, pageDirectory), page.message);
  }

  private async keepOpen(): Promise<void> {
    try {
      this.textDocument = await vscode.workspace.openTextDocument(this.uri);
    } catch (error) {
      this.deps.logger.warn(`Preview of ${fileName(this.uri)}: could not open the document: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(message: unknown): void {
    const inbound = inboundMessage(message);
    if (inbound?.type === 'zenwave.preview.followLink') void this.followLink(inbound.payload.href);
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'zenwave.preview.copyMermaid') {
      const content = (message as { payload?: { content?: unknown } }).payload?.content;
      if (typeof content === 'string') void Promise.resolve(vscode.env.clipboard.writeText(content)).catch((error: unknown) => {
        this.deps.logger.warn(`Preview of ${fileName(this.uri)}: could not copy Mermaid source: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const wasLoading = this.session.page.kind === 'loading';
    this.session.receive(message);
    if (wasLoading && this.session.page.kind !== 'loading' && this.loadTimer !== undefined) {
      clearTimeout(this.loadTimer);
      this.loadTimer = undefined;
    }
    this.showFailedPage();
  }

  private async followLink(href: string): Promise<void> {
    const decision = decidePreviewLink(this.documentUri, href, (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()));
    try {
      if (decision.kind === 'external') {
        await vscode.env.openExternal(vscode.Uri.parse(decision.href, true));
      } else if (decision.kind === 'workspace') {
        const target = vscode.Uri.parse(decision.href, true);
        if (decision.line !== undefined) {
          const position = new vscode.Position(decision.line - 1, 0);
          await vscode.window.showTextDocument(target.with({ fragment: '' }), { preview: false, selection: new vscode.Range(position, position) });
        } else {
          await vscode.commands.executeCommand('vscode.open', target);
        }
      }
    } catch (error) {
      this.deps.logger.warn(`Preview of ${fileName(this.uri)}: could not follow ${href}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The host decides what the title bar shows, from the editor active now (MP-R26): a page that changed while this preview was in the background still counts once it is shown. */
  private publishContext(): void {
    this.deps.onContextChange();
  }

  private viewStateChanged(): void {
    this.startLoadTimer();
    if (this.panel.active) this.deps.onFocus(this);
    this.deps.onContextChange();
  }

  settled(): Promise<void> {
    return this.refresher.idle();
  }

  probe(followLink?: string, copyMermaid?: number): Promise<PreviewProbe> {
    return this.session.probe(followLink, copyMermaid);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.loadTimer !== undefined) clearTimeout(this.loadTimer);
    this.refresher.dispose();
    // A remembered session outlives the panel: the next following preview brings it back.
    if (!this.deps.memory) this.session.dispose();
    for (const subscription of [...this.subscriptions, ...this.watcher]) subscription.dispose();
    this.textDocument = undefined;
    this.deps.onDispose(this);
  }
}

const isPreviewTab = (uri: vscode.Uri) => (input: unknown): boolean =>
  input instanceof vscode.TabInputCustom && input.viewType === PREVIEW_VIEW_TYPE && input.uri.toString() === uri.toString();

/** The tab holding a document's preview, in any group. */
function previewTab(uri: vscode.Uri): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const tab = findTab(group, isPreviewTab(uri));
    if (tab) return tab;
  }
  return undefined;
}

export function registerPreviewEditor(
  context: vscode.ExtensionContext,
  server: LanguageServerApi,
  logger: Logger,
): PreviewApi {
  const editors = new Set<PreviewEditor>();
  /** The mode a command asked for a preview that is still opening; read once when its editor is created. */
  const pendingModes = new Map<string, PreviewMode>();
  let active: PreviewEditor | undefined;
  /** The window's following preview and what it remembers per file (MP-R31). */
  let following: PreviewEditor | undefined;
  const memory = new FollowingMemory<PreviewSession>();
  let markdownPublished: boolean | undefined;

  /** Whether the following preview is the active editor, by the active tab or, for a tab the host has not listed yet, its panel's flag. */
  function followingIsActive(): boolean {
    if (!following) return false;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab) return tab.input instanceof vscode.TabInputWebview && isFollowingViewType(tab.input.viewType);
    return following.panel.active;
  }

  /** The preview that is the active editor: the active tab says so, and its panel's own flag covers a tab the host has not listed yet. */
  function activePreviewUri(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab) return tab.input instanceof vscode.TabInputCustom && tab.input.viewType === PREVIEW_VIEW_TYPE ? tab.input.uri.toString() : undefined;
    return [...editors].find((editor) => editor.panel.active)?.documentUri;
  }

  /** Publishes whether the title bar offers Copy as Markdown, once per change (MP-R26); for the following preview too (MP-R31). */
  function syncMarkdownContext(): void {
    const lock = followingIsActive();
    const value = lock && following
      ? following.session.showsMarkdown
      : markdownContextValue(activePreviewUri(), [...editors].map((editor) => ({ documentUri: editor.documentUri, showsMarkdown: editor.session.showsMarkdown })));
    if (value === markdownPublished) return;
    markdownPublished = value;
    void vscode.commands.executeCommand('setContext', PREVIEW_MARKDOWN_CONTEXT_KEY, value);
  }

  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
    resolveCustomEditor: (document, panel) => {
      const editor = new PreviewEditor(document.uri, panel, {
        context, server, logger,
        onDispose: (closed) => {
          editors.delete(closed);
          if (active === closed) active = undefined;
          syncMarkdownContext();
        },
        onContextChange: syncMarkdownContext,
        initialMode: (documentUri) => { const mode = pendingModes.get(documentUri) ?? 'docs'; pendingModes.delete(documentUri); return mode; },
        onFocus: (focused) => { active = focused; },
      });
      editors.add(editor);
      logger.info(`Preview opened for ${fileName(document.uri)}`);
    },
  };

  /** The preview a command applies to: the one for the URI a menu (or a caller, as `documentUri`) named, or the focused one. */
  function target(argument: unknown): PreviewEditor | undefined {
    const candidates = [...editors];
    const named = (argument as { documentUri?: unknown } | undefined)?.documentUri;
    if (argument instanceof vscode.Uri || typeof named === 'string') {
      const uri = argument instanceof vscode.Uri ? argument.toString() : String(named);
      return candidates.find((editor) => editor.documentUri === uri && editor.panel.active) ??
        (active?.documentUri === uri ? active : candidates.find((editor) => editor.documentUri === uri));
    }
    return [...candidates, ...(following ? [following] : [])].find((editor) => editor.panel.active) ?? active;
  }

  function noDocument(argument: unknown): PreviewOpenOutcome {
    const untitled = commandDocument(argument, (uri) => uri.scheme === 'untitled');
    if (untitled) {
      void vscode.window.showInformationMessage('Save this model to a .zdl, .zw or .zfl file first: a preview is of a saved file.');
      return { kind: 'untitled' };
    }
    void vscode.window.showInformationMessage('Open a ZDL, ZW or ZFL model to preview it.');
    return { kind: 'no-document' };
  }

  /** A document has one preview: when it already has one, that one is shown instead of opening another. */
  async function reveal(uri: vscode.Uri, preserveFocus: boolean): Promise<boolean> {
    const existing = previewTab(uri);
    if (!existing) return false;
    await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, { viewColumn: existing.group.viewColumn, preserveFocus });
    return true;
  }

  async function openToSide(argument: unknown): Promise<PreviewOpenOutcome> {
    const uri = commandDocument(argument, isPreviewableDocument);
    if (!uri) return noDocument(argument);
    if (!await reveal(uri, true)) {
      await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    }
    return { kind: 'opened', documentUri: uri.toString() };
  }

  /** Model Docs beside the text (MP-R27): the preview opens as `openToSide` does, then shows the page, as `openModelDocs` does. */
  async function openModelDocsToSide(argument: unknown): Promise<PreviewOpenOutcome> {
    const outcome = await openToSide(argument);
    if (outcome.kind === 'opened') {
      for (const editor of [...editors].filter((candidate) => candidate.documentUri === outcome.documentUri)) await editor.session.setPreviewMode('docs');
    }
    return outcome;
  }

  async function open(argument: unknown): Promise<PreviewOpenOutcome> {
    const uri = commandDocument(argument, isPreviewableDocument);
    if (!uri) return noDocument(argument);
    if (!await reveal(uri, false)) {
      const group = vscode.window.tabGroups.activeTabGroup;
      const textTab = findTab(group, (input) => input instanceof vscode.TabInputText && input.uri.toString() === uri.toString());
      const openPreview = (column: vscode.ViewColumn): Thenable<unknown> =>
        vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, { viewColumn: column, preserveFocus: false });
      if (textTab) {
        if (textTab.isDirty) logger.info(`Preview of ${fileName(uri)}: the text has unsaved changes, so it stays open beside the preview`);
        await replaceInPlace(textTab, openPreview);
      } else {
        await openPreview(group.viewColumn);
      }
    }
    return { kind: 'opened', documentUri: uri.toString() };
  }

  /** Opens the preview and chooses what it shows: the page (Model Docs) or one diagram at a time (ZDL Diagrams, MP-R25). */
  async function openInMode(argument: unknown, mode: PreviewMode): Promise<PreviewOpenOutcome> {
    if (followingIsActive() && following) {
      // From inside the following preview, a mode is chosen for the file it shows (MP-R31).
      if (!await following.session.setPreviewMode(mode)) void vscode.window.showInformationMessage('The language server does not offer ZDL Diagrams.');
      return { kind: 'opened', documentUri: following.documentUri };
    }
    const uri = commandDocument(argument, isPreviewableDocument);
    if (mode === 'diagrams') {
      if (uri && !server.previewModes) {
        void vscode.window.showInformationMessage('The language server does not offer ZDL Diagrams.');
        logger.info(`Preview of ${fileName(uri)}: ZDL Diagrams needs a server that advertises previewModes`);
        return open(argument);
      }
      if (uri) pendingModes.set(uri.toString(), mode);
    }
    let outcome: PreviewOpenOutcome;
    try {
      outcome = await open(argument);
    } catch (error) {
      // A failed open must not leave its mode for the next editor of this document.
      if (uri) pendingModes.delete(uri.toString());
      throw error;
    }
    if (outcome.kind !== 'opened') {
      if (uri) pendingModes.delete(uri.toString());
      return outcome;
    }
    const resolved = [...editors].filter((editor) => editor.documentUri === outcome.documentUri);
    if (resolved.length > 0) {
      // The editor exists already (or was created before this resolved): tell it directly.
      pendingModes.delete(outcome.documentUri);
      for (const editor of resolved) await editor.session.setPreviewMode(mode);
    } else if (mode === 'diagrams') {
      // The editor may be created after `openWith` resolves; its constructor reads the entry. Not a permanent one.
      const timer = setTimeout(() => { if (pendingModes.get(outcome.documentUri) === mode) pendingModes.delete(outcome.documentUri); }, PENDING_MODE_MS);
      context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
    return outcome;
  }

  async function showText(argument: unknown): Promise<PreviewOpenOutcome> {
    const editor = target(argument);
    const uri = editor ? vscode.Uri.parse(editor.documentUri, true) : commandDocument(argument, isPreviewableDocument);
    if (!uri) return noDocument(argument);
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = findTab(group, isPreviewTab(uri));
    const openText = (column: vscode.ViewColumn): Thenable<unknown> => vscode.window.showTextDocument(uri, { viewColumn: column, preview: false });
    if (tab) await replaceInPlace(tab, openText);
    else await openText(group.viewColumn);
    return { kind: 'opened', documentUri: uri.toString() };
  }

  /** `argument` is a URI from a menu, or `{ representationId, documentUri? }` to choose without asking. */
  async function selectDiagram(argument: unknown): Promise<PreviewSelectOutcome> {
    const editor = target(argument);
    if (!editor || !editor.session.hasPreview) {
      void vscode.window.showInformationMessage('Open a preview with something to show to choose a diagram.');
      return { kind: 'no-preview' };
    }
    const chosen = (argument as { representationId?: unknown } | undefined)?.representationId;
    if (typeof chosen === 'string') {
      return editor.session.selectRepresentation(chosen) ? { kind: 'selected', value: chosen } : { kind: 'unavailable' };
    }
    const { selectedId, representations } = editor.session;
    const pick = await vscode.window.showQuickPick(
      representations.map((item) => ({ label: item.title, description: [item.group, item.id === selectedId ? 'shown' : undefined].filter((part) => part !== undefined).join(' · '), id: item.id })),
      { title: 'Diagram', placeHolder: 'Choose what the preview shows' },
    );
    if (!pick) return { kind: 'cancelled' };
    editor.session.selectRepresentation(pick.id);
    return { kind: 'selected', value: pick.id };
  }

  /** `argument` is a URI from a menu, or `{ renderMode, documentUri? }` to choose without asking. */
  async function selectRenderMode(argument: unknown): Promise<PreviewSelectOutcome> {
    const editor = target(argument);
    if (!editor || !editor.session.hasPreview) {
      void vscode.window.showInformationMessage('Open the preview of a ZFL flow to choose how its sequences are rendered.');
      return { kind: 'no-preview' };
    }
    const chosen = (argument as { renderMode?: unknown } | undefined)?.renderMode;
    if (isRenderMode(chosen)) {
      await editor.session.setRenderMode(chosen);
      return { kind: 'selected', value: chosen };
    }
    const pick = await vscode.window.showQuickPick(
      RENDER_MODES.map((mode) => ({ label: mode.label, ...(mode.value === editor.session.renderMode ? { description: 'current' } : {}), value: mode.value as RenderMode })),
      { title: 'Render mode', placeHolder: 'How are sequence variants rendered?' },
    );
    if (!pick) return { kind: 'cancelled' };
    await editor.session.setRenderMode(pick.value);
    return { kind: 'selected', value: pick.value };
  }

  /** Copies the Markdown page on screen, unchanged. A diagram page copies nothing (MP-R26). */
  async function copyMarkdown(argument: unknown): Promise<boolean> {
    const editor = target(argument);
    if (!editor) return false;
    try {
      return await editor.session.copyMarkdown((text) => vscode.env.clipboard.writeText(text));
    } catch (error) {
      logger.warn(`Preview of ${fileName(vscode.Uri.parse(editor.documentUri, true))}: could not copy Markdown: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** One following preview per window, beside the text (MP-R31): the one that exists is revealed and shows the file the command was run on. */
  async function openFollowing(argument: unknown): Promise<PreviewOpenOutcome> {
    const uri = commandDocument(argument, (candidate, languageId) => isPreviewableDocument(candidate, languageId) && followsLanguage(languageId, candidate.path));
    if (following) {
      following.panel.reveal(undefined, true);
      if (uri) following.showDocument(uri);
      return { kind: 'opened', documentUri: following.documentUri };
    }
    if (!uri) return noDocument(argument);
    const title = followingTitle(fileName(uri));
    const pageDirectory = vscode.Uri.joinPath(context.extensionUri, ...PAGE_DIRECTORY);
    const panel = vscode.window.createWebviewPanel(FOLLOWING_VIEW_TYPE, title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [pageDirectory] });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'zenwave-preview-light.svg');
    const editor = new PreviewEditor(uri, panel, {
      context, server, logger, memory,
      onDispose: (closed) => {
        if (following === closed) following = undefined;
        if (active === closed) active = undefined;
        syncMarkdownContext();
      },
      onContextChange: syncMarkdownContext,
      initialMode: () => 'docs',
      onFocus: (focused) => { active = focused; },
    });
    following = editor;
    logger.info(`Following preview opened for ${fileName(uri)}`);
    return { kind: 'opened', documentUri: uri.toString() };
  }

  /** The lock: the following preview becomes the ordinary preview (MP-R3) of the file it shows, in its place. */
  async function lockFollowing(): Promise<PreviewOpenOutcome> {
    const editor = following;
    if (!editor) return { kind: 'no-document' };
    const uri = vscode.Uri.parse(editor.documentUri, true);
    const column = editor.panel.viewColumn ?? vscode.ViewColumn.Beside;
    const mode = editor.session.requestedMode;
    if (!await reveal(uri, false)) {
      pendingModes.set(editor.documentUri, mode);
      const timer = setTimeout(() => pendingModes.delete(editor.documentUri), PENDING_MODE_MS);
      context.subscriptions.push({ dispose: () => clearTimeout(timer) });
      await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, { viewColumn: column, preserveFocus: false });
    }
    editor.panel.dispose();
    logger.info(`Following preview locked on ${fileName(uri)}`);
    return { kind: 'opened', documentUri: uri.toString() };
  }

  /** The following preview moves with the last focused text editor of a model, and with nothing else (MP-R31). */
  function editorFocused(editor: vscode.TextEditor | undefined): void {
    if (!following) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const document = editor?.document;
    const target = followTarget(
      editor && document ? { uri: document.uri.toString(), previewable: isPreviewableDocument(document.uri, document.languageId) && followsLanguage(document.languageId, document.uri.path), inDiff: tab?.input instanceof vscode.TabInputTextDiff } : undefined,
      following.documentUri,
    );
    if (target !== undefined && document) following.showDocument(document.uri);
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PREVIEW_VIEW_TYPE, provider, {
      // A preview keeps its drawing and scroll while its tab is in the background, instead of redrawing on every switch.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openToSide, openToSide),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.open, open),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openSequenceDiagrams, open),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openModelDocs, (argument: unknown) => openInMode(argument, 'docs')),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openZdlDiagrams, (argument: unknown) => openInMode(argument, 'diagrams')),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openScriptsDocs, open),
    // VS Code shows one title per command, so each view has its own "to the side" entry (MP-R27).
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openSequenceDiagramsToSide, openToSide),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openModelDocsToSide, openModelDocsToSide),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openScriptsDocsToSide, openToSide),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.showText, showText),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.selectDiagram, selectDiagram),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.selectRenderMode, selectRenderMode),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.copyMarkdown, copyMarkdown),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.openFollowing, openFollowing),
    vscode.commands.registerCommand(PREVIEW_COMMANDS.lockFollowing, lockFollowing),
    vscode.window.onDidChangeActiveTextEditor(editorFocused),
    // The title bar follows the active editor: a tab change, in any group, is when it may need to change.
    vscode.window.tabGroups.onDidChangeTabs(syncMarkdownContext),
    vscode.window.tabGroups.onDidChangeTabGroups(syncMarkdownContext),
    { dispose: () => { for (const editor of [...editors, ...(following ? [following] : [])]) editor.dispose(); } },
  );

  return {
    get editors() { return [...editors]; },
    get following() { return following; },
    editorsFor: (documentUri) => [...editors].filter((editor) => editor.documentUri === documentUri),
    get active() { return active && (editors.has(active) || active === following) ? active : undefined; },
  };
}
