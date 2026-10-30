import * as vscode from 'vscode';
import { CoalescedRefresh } from '../explorer/coalesce.js';
import type { DiagramPanels, Registration } from '../explorer/diagram-selection.js';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { commandDocument, isZflDocument } from '../model/active-document.js';
import { fileName, findTab, replaceInPlace } from '../model/editor-tabs.js';
import { buildFallbackHtml, buildPageHtml, createNonce } from './page.js';
import { EVENTFLOW_VIEW_TYPE, type PageProbe, type ViewMode } from './protocol.js';
import { DiagramSession } from './session.js';

export const EVENTFLOW_COMMANDS = {
  open: 'zenwave.eventflow.open',
  openToSide: 'zenwave.eventflow.openToSide',
  showText: 'zenwave.eventflow.showText',
  showServiceView: 'zenwave.eventflow.showServiceView',
  showFlowView: 'zenwave.eventflow.showFlowView',
  showLabelsAsWritten: 'zenwave.eventflow.showLabelsAsWritten',
  showHumanizedLabels: 'zenwave.eventflow.showHumanizedLabels',
} as const;

/** State of the focused diagram editor, for the title-bar toggles' `when` clauses. */
export const EVENTFLOW_CONTEXT_KEYS = {
  viewMode: 'zenwave.eventflowViewMode',
  humanizeLabels: 'zenwave.eventflowHumanizeLabels',
} as const;

/**
 * The editor-title submenu gathering the ways to view a model document (the
 * EventFlow diagram here, the preview in `src/preview`). One ZenWave icon instead of one icon per view.
 */
export const MODEL_VIEWS_SUBMENU = 'zenwave.modelViews';

/** Where the upstream page is copied by the build (esbuild.mjs). */
const PAGE_DIRECTORY = ['dist', 'eventflow-webview'] as const;
/** A burst of keystrokes is one request once typing pauses this long. */
const EDIT_DELAY_MS = 300;
const SWITCH_DELAY_MS = 50;
/** How long a visible page may take to say it loaded before the editor calls it a failure. */
const PAGE_LOAD_SECONDS = 30;

export type EventFlowOpenOutcome =
  | { readonly kind: 'opened'; readonly documentUri: string }
  | { readonly kind: 'no-document' };

export interface EventFlowEditorApi {
  readonly documentUri: string;
  readonly panel: vscode.WebviewPanel;
  readonly session: DiagramSession;
  /** Resolves when no request is scheduled or running. */
  settled(): Promise<void>;
  probe(): Promise<PageProbe>;
}

export interface EventFlowApi {
  readonly editors: readonly EventFlowEditorApi[];
  editorsFor(documentUri: string): readonly EventFlowEditorApi[];
  /** The diagram editor with focus, if any. */
  readonly active: EventFlowEditorApi | undefined;
}

interface Initial {
  readonly viewMode: ViewMode;
  readonly humanizeLabels: boolean;
}

function readInitial(uri: vscode.Uri): Initial {
  const settings = vscode.workspace.getConfiguration('zenwave.eventflow', uri);
  return {
    viewMode: settings.get<string>('defaultView', 'flow') === 'services' ? 'services' : 'flow',
    humanizeLabels: settings.get<boolean>('humanizeLabels', true),
  };
}

class EventFlowEditor implements EventFlowEditorApi, vscode.Disposable {
  readonly documentUri: string;
  readonly session: DiagramSession;
  private readonly refresher: CoalescedRefresh;
  private readonly subscriptions: vscode.Disposable[] = [];
  private registration: Registration | undefined;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Holds the document open as text, so the language server has it even when no text editor shows it. */
  textDocument: vscode.TextDocument | undefined;

  constructor(
    private readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly deps: { readonly context: vscode.ExtensionContext; readonly server: LanguageServerApi; readonly logger: Logger; readonly diagramPanels: DiagramPanels; readonly onDispose: (editor: EventFlowEditor) => void; readonly onFocus: (editor: EventFlowEditor) => void },
  ) {
    this.documentUri = uri.toString();
    const initial = readInitial(uri);
    const webview = panel.webview;
    const pageDirectory = vscode.Uri.joinPath(deps.context.extensionUri, ...PAGE_DIRECTORY);
    webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [pageDirectory] };
    this.session = new DiagramSession({
      documentUri: this.documentUri,
      fileName: fileName(uri),
      eventFlowViews: (target) => deps.server.requests.eventFlowViews(target),
      post: (message) => webview.postMessage(message),
      runCommand: (command) => { void vscode.commands.executeCommand(command); },
      log: deps.logger,
    }, { viewMode: initial.viewMode, displaySettings: { humanizeLabels: initial.humanizeLabels } });
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
    // A change on disk (a branch switch, another tool) reaches an open text document as a change event; the
    // watcher covers a document whose text model VS Code has not loaded yet.
    if (uri.scheme === 'file' || uri.scheme === 'vscode-vfs' || uri.scheme === 'vscode-test-web') {
      const directory = vscode.Uri.joinPath(uri, '..');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, fileName(uri)));
      this.subscriptions.push(watcher, watcher.onDidChange(() => this.refresher.request()), watcher.onDidCreate(() => this.refresher.request()));
    }

    void this.load(webview, pageDirectory);
    void this.keepOpen().then(() => this.refresher.request(SWITCH_DELAY_MS));
    this.viewStateChanged();
  }

  private async load(webview: vscode.Webview, pageDirectory: vscode.Uri): Promise<void> {
    const nonce = createNonce();
    try {
      const index = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(pageDirectory, 'index.html')));
      webview.html = buildPageHtml(index, {
        assetUri: (relative) => webview.asWebviewUri(vscode.Uri.joinPath(pageDirectory, ...relative.split('/'))).toString(),
        cspSource: webview.cspSource,
        nonce,
      });
      this.startLoadTimer();
    } catch (error) {
      webview.html = buildFallbackHtml({ cspSource: webview.cspSource, nonce });
      this.session.pageFailed(`The EventFlow page shipped with the extension could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startLoadTimer(): void {
    if (this.loadTimer !== undefined || this.session.page.kind !== 'loading' || !this.panel.visible) return;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      if (this.panel.visible) this.session.pageTimedOut(PAGE_LOAD_SECONDS);
    }, PAGE_LOAD_SECONDS * 1000);
  }

  private async keepOpen(): Promise<void> {
    try {
      this.textDocument = await vscode.workspace.openTextDocument(this.uri);
    } catch (error) {
      this.deps.logger.warn(`EventFlow diagram for ${fileName(this.uri)}: could not open the document: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(message: unknown): void {
    const wasReady = this.session.page.kind === 'ready';
    this.session.receive(message);
    if (!wasReady && this.session.page.kind === 'ready') {
      if (this.loadTimer !== undefined) clearTimeout(this.loadTimer);
      this.loadTimer = undefined;
      this.registration ??= this.deps.diagramPanels.register(this.documentUri, { highlightNode: (id) => this.session.highlightNode(id) });
    }
  }

  private viewStateChanged(): void {
    this.startLoadTimer();
    if (this.panel.active) this.deps.onFocus(this);
  }

  setViewMode(viewMode: ViewMode): void {
    this.session.setViewMode(viewMode);
    if (this.panel.active) this.deps.onFocus(this);
  }

  setHumanizeLabels(humanizeLabels: boolean): void {
    this.session.setDisplaySettings({ humanizeLabels });
    if (this.panel.active) this.deps.onFocus(this);
  }

  settled(): Promise<void> {
    return this.refresher.idle();
  }

  probe(): Promise<PageProbe> {
    return this.session.probe();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.loadTimer !== undefined) clearTimeout(this.loadTimer);
    this.registration?.dispose();
    this.refresher.dispose();
    this.session.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.textDocument = undefined;
    this.deps.onDispose(this);
  }
}

export function registerEventFlowEditor(
  context: vscode.ExtensionContext,
  server: LanguageServerApi,
  logger: Logger,
  diagramPanels: DiagramPanels,
): EventFlowApi {
  const editors = new Set<EventFlowEditor>();
  let active: EventFlowEditor | undefined;

  function publish(editor: EventFlowEditor): void {
    active = editor;
    void vscode.commands.executeCommand('setContext', EVENTFLOW_CONTEXT_KEYS.viewMode, editor.session.viewMode);
    void vscode.commands.executeCommand('setContext', EVENTFLOW_CONTEXT_KEYS.humanizeLabels, editor.session.displaySettings.humanizeLabels);
  }

  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
    resolveCustomEditor: (document, panel) => {
      const editor = new EventFlowEditor(document.uri, panel, {
        context, server, logger, diagramPanels,
        onDispose: (closed) => { editors.delete(closed); if (active === closed) active = undefined; },
        onFocus: publish,
      });
      editors.add(editor);
      logger.info(`EventFlow diagram opened for ${fileName(document.uri)}`);
    },
  };

  /** The diagram a toggle applies to: the one for the URI the title bar passed, or the focused one. */
  function target(argument: unknown): EventFlowEditor | undefined {
    const candidates = [...editors];
    if (argument instanceof vscode.Uri) {
      const uri = argument.toString();
      return candidates.find((editor) => editor.documentUri === uri && editor.panel.active) ??
        (active?.documentUri === uri ? active : candidates.find((editor) => editor.documentUri === uri));
    }
    return candidates.find((editor) => editor.panel.active) ?? active;
  }

  async function openToSide(argument: unknown): Promise<EventFlowOpenOutcome> {
    const uri = commandDocument(argument, isZflDocument);
    if (!uri) return noDocument();
    await vscode.commands.executeCommand('vscode.openWith', uri, EVENTFLOW_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    return { kind: 'opened', documentUri: uri.toString() };
  }

  async function open(argument: unknown): Promise<EventFlowOpenOutcome> {
    const uri = commandDocument(argument, isZflDocument);
    if (!uri) return noDocument();
    const group = vscode.window.tabGroups.activeTabGroup;
    const textTab = findTab(group, (input) => input instanceof vscode.TabInputText && input.uri.toString() === uri.toString());
    const openDiagram = (column: vscode.ViewColumn): Thenable<unknown> =>
      vscode.commands.executeCommand('vscode.openWith', uri, EVENTFLOW_VIEW_TYPE, { viewColumn: column, preserveFocus: false });
    if (textTab) {
      if (textTab.isDirty) logger.info(`EventFlow diagram for ${fileName(uri)}: the text has unsaved changes, so it stays open beside the diagram`);
      await replaceInPlace(textTab, openDiagram);
    } else {
      await openDiagram(group.viewColumn);
    }
    return { kind: 'opened', documentUri: uri.toString() };
  }

  async function showText(argument: unknown): Promise<EventFlowOpenOutcome> {
    const editor = target(argument);
    const uri = editor ? vscode.Uri.parse(editor.documentUri, true) : commandDocument(argument, isZflDocument);
    if (!uri) return noDocument();
    const group = vscode.window.tabGroups.activeTabGroup;
    const diagramTab = findTab(group, (input) => input instanceof vscode.TabInputCustom && input.viewType === EVENTFLOW_VIEW_TYPE && input.uri.toString() === uri.toString());
    const openText = (column: vscode.ViewColumn): Thenable<unknown> => vscode.window.showTextDocument(uri, { viewColumn: column, preview: false });
    if (diagramTab) await replaceInPlace(diagramTab, openText);
    else await openText(group.viewColumn);
    return { kind: 'opened', documentUri: uri.toString() };
  }

  function noDocument(): EventFlowOpenOutcome {
    void vscode.window.showInformationMessage('Open a ZFL flow to view it as an EventFlow diagram.');
    return { kind: 'no-document' };
  }

  function toggle(apply: (editor: EventFlowEditor) => void): (argument: unknown) => boolean {
    return (argument) => {
      const editor = target(argument);
      if (!editor) return false;
      apply(editor);
      return true;
    };
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EVENTFLOW_VIEW_TYPE, provider, {
      // A diagram keeps its rendering while its tab is in the background, instead of re-rendering on every switch.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.openToSide, openToSide),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.open, open),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.showText, showText),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.showServiceView, toggle((editor) => editor.setViewMode('services'))),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.showFlowView, toggle((editor) => editor.setViewMode('flow'))),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.showLabelsAsWritten, toggle((editor) => editor.setHumanizeLabels(false))),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.showHumanizedLabels, toggle((editor) => editor.setHumanizeLabels(true))),
    { dispose: () => { for (const editor of [...editors]) editor.dispose(); } },
  );

  return {
    get editors() { return [...editors]; },
    editorsFor: (documentUri) => [...editors].filter((editor) => editor.documentUri === documentUri),
    get active() { return active && editors.has(active) ? active : undefined; },
  };
}
