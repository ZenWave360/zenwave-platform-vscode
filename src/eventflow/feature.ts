import * as vscode from 'vscode';
import { CoalescedRefresh } from '../explorer/coalesce.js';
import type { DiagramPanels, Registration } from '../explorer/diagram-selection.js';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { commandDocument, isZflDocument } from '../model/active-document.js';
import { fileName, findTab, replaceInPlace } from '../model/editor-tabs.js';
import type { ConfirmationAnswer, ConfirmationRequest } from '../model/actions.js';
import { buildFallbackHtml, buildPageHtml, createNonce } from './page.js';
import { parsePositionsFile, positionsFileName, serializePositions, type PositionsFile } from './positions.js';
import { EVENTFLOW_VIEW_TYPE, LANES, type Lanes, type PageProbe, type ViewMode } from './protocol.js';
import { DiagramSession } from './session.js';

export const EVENTFLOW_COMMANDS = {
  open: 'zenwave.eventflow.open',
  openToSide: 'zenwave.eventflow.openToSide',
  showText: 'zenwave.eventflow.showText',
  showServiceView: 'zenwave.eventflow.showServiceView',
  showFlowView: 'zenwave.eventflow.showFlowView',
  showLabelsAsWritten: 'zenwave.eventflow.showLabelsAsWritten',
  showHumanizedLabels: 'zenwave.eventflow.showHumanizedLabels',
  discardSavedPositions: 'zenwave.eventflow.discardSavedPositions',
  lanes: 'zenwave.eventflow.lanes',
} as const;

/** State of the focused diagram editor, for the commands' `when` clauses. */
export const EVENTFLOW_CONTEXT_KEYS = {
  viewMode: 'zenwave.eventflowViewMode',
  humanizeLabels: 'zenwave.eventflowHumanizeLabels',
  /** A saved-positions file is beside the focused diagram's model (EF-R14). */
  positionsExist: 'zenwave.eventflowPositionsExist',
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
  /** What `zenwave.eventflowViewMode` was last set to, for tests: the context key cannot be read back. */
  readonly contextViewMode: ViewMode | undefined;
  /** Answers every *Discard Saved Positions* confirmation with `answer` (the button, or `undefined` for Cancel or Escape) and records it. For tests. */
  answerDiscardSavedPositions(answer: string | undefined): ConfirmationAnswer;
}

export const DISCARD_BUTTON = 'Discard';

interface Initial {
  readonly viewMode: ViewMode;
  readonly humanizeLabels: boolean;
  readonly lanes: Lanes;
}

function readInitial(uri: vscode.Uri): Initial {
  const settings = vscode.workspace.getConfiguration('zenwave.eventflow', uri);
  return {
    viewMode: settings.get<string>('defaultView', 'flow') === 'services' ? 'services' : 'flow',
    humanizeLabels: settings.get<boolean>('humanizeLabels', true),
    lanes: LANES.find((lanes) => lanes === settings.get<string>('lanes', 'none')) ?? 'none',
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
      documentVersion: () => this.textDocument?.isClosed === false ? this.textDocument.version : undefined,
      fileName: fileName(uri),
      eventFlowViews: (target, variant, positions, lanes) => deps.server.requests.eventFlowViews(target, variant, positions, lanes),
      flowLanes: () => deps.server.flowLanes,
      flowVariants: () => deps.server.flowVariants,
      savedPositions: () => deps.server.savedPositions,
      positionsFile: this.positionsFile(),
      post: (message) => webview.postMessage(message),
      runCommand: (command) => { void vscode.commands.executeCommand(command); },
      log: deps.logger,
      warn: (message) => { void vscode.window.showWarningMessage(message); },
      positionsExistChanged: () => { if (panel.active) deps.onFocus(this); },
    }, { viewMode: initial.viewMode, displaySettings: { humanizeLabels: initial.humanizeLabels, lanes: initial.lanes } });
    this.refresher = new CoalescedRefresh(async () => {
      await this.session.refresh();
      if (this.panel.active) this.deps.onFocus(this);
    }, EDIT_DELAY_MS);

    this.subscriptions.push(
      webview.onDidReceiveMessage((message) => this.receive(message)),
      panel.onDidChangeViewState(() => this.viewStateChanged()),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.documentUri && event.contentChanges.length > 0) this.refresher.request();
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.toString() === this.documentUri) {
          this.textDocument = document;
          this.refresher.request(SWITCH_DELAY_MS);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === this.documentUri && !this.disposed) void this.keepOpen();
      }),
      deps.server.onDidChange(() => {
        this.session.invalidateRefresh();
        this.refresher.request(SWITCH_DELAY_MS);
      }),
    );
    // A change on disk (a branch switch, another tool) reaches an open text document as a change event; the
    // watcher covers a document whose text model VS Code has not loaded yet.
    if (uri.scheme === 'file' || uri.scheme === 'vscode-vfs' || uri.scheme === 'vscode-test-web') {
      const directory = vscode.Uri.joinPath(uri, '..');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, fileName(uri)));
      this.subscriptions.push(watcher, watcher.onDidChange(() => this.refresher.request()), watcher.onDidCreate(() => this.refresher.request()));
      // The positions file is read through the host's file system, so a change by another tool or a branch switch reaches the diagram too.
      const positions = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, positionsFileName(fileName(uri))));
      const again = (): void => { void this.session.positionsFileChanged().then((changed) => { if (changed) this.refresher.request(); }); };
      this.subscriptions.push(positions, positions.onDidChange(again), positions.onDidCreate(again), positions.onDidDelete(again));
    }

    void this.load(webview, pageDirectory);
    void this.keepOpen().then(() => this.refresher.request(SWITCH_DELAY_MS));
    this.viewStateChanged();
  }

  private positionsUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.uri, '..', positionsFileName(fileName(this.uri)));
  }

  private positionsFile() {
    return {
      read: async (): Promise<PositionsFile> => {
        let bytes: Uint8Array;
        try {
          bytes = await vscode.workspace.fs.readFile(this.positionsUri());
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return { exists: false };
          throw error;
        }
        return parsePositionsFile(new TextDecoder().decode(bytes));
      },
      write: async (positions: Parameters<typeof serializePositions>[0]): Promise<'written' | 'read-only'> => {
        const writable = vscode.workspace.fs.isWritableFileSystem(this.uri.scheme);
        if (writable === undefined) throw new Error(`no file system for "${this.uri.scheme}" is available to write to`);
        if (writable === false) {
          void vscode.window.showInformationMessage(`The workspace is read-only, so the positions of ${fileName(this.uri)} cannot be saved.`);
          return 'read-only';
        }
        await vscode.workspace.fs.writeFile(this.positionsUri(), new TextEncoder().encode(serializePositions(positions)));
        this.deps.logger.info(`EventFlow diagram for ${fileName(this.uri)}: saved positions to ${positionsFileName(fileName(this.uri))}`);
        return 'written';
      },
      remove: async (): Promise<void> => {
        try {
          await vscode.workspace.fs.delete(this.positionsUri());
          this.deps.logger.info(`EventFlow diagram for ${fileName(this.uri)}: discarded ${positionsFileName(fileName(this.uri))}`);
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
        }
      },
    };
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
    const viewMode = this.session.viewMode;
    const humanizeLabels = this.session.displaySettings.humanizeLabels;
    this.session.receive(message);
    // The focused editor's context keys follow the page's view and labels choices.
    if ((this.session.viewMode !== viewMode || this.session.displaySettings.humanizeLabels !== humanizeLabels) && this.panel.active) this.deps.onFocus(this);
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

  setLanes(lanes: Lanes): void {
    this.session.setLanes(lanes);
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
  let contextViewMode: ViewMode | undefined;

  function publish(editor: EventFlowEditor): void {
    active = editor;
    contextViewMode = editor.session.viewMode;
    void vscode.commands.executeCommand('setContext', EVENTFLOW_CONTEXT_KEYS.viewMode, editor.session.viewMode);
    void vscode.commands.executeCommand('setContext', EVENTFLOW_CONTEXT_KEYS.humanizeLabels, editor.session.displaySettings.humanizeLabels);
    void vscode.commands.executeCommand('setContext', EVENTFLOW_CONTEXT_KEYS.positionsExist, editor.session.savedPositionsExist);
  }

  let answering: { readonly answer: string | undefined; readonly requests: ConfirmationRequest[] } | undefined;

  async function discardSavedPositions(argument: unknown): Promise<'discarded' | 'cancelled' | 'no-diagram'> {
    const editor = target(argument);
    if (!editor) return 'no-diagram';
    const message = `Discard the saved positions of ${fileName(vscode.Uri.parse(editor.documentUri, true))}?`;
    const detail = 'The saved positions file is deleted and the diagram goes back to automatic layout. This cannot be undone.';
    let answer: string | undefined;
    if (answering) {
      answering.requests.push({ message, modal: true, buttons: [DISCARD_BUTTON] });
      answer = answering.answer;
    } else {
      answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, DISCARD_BUTTON);
    }
    if (answer !== DISCARD_BUTTON) return 'cancelled';
    await editor.session.discardSavedPositions();
    if (editor.panel.active) publish(editor);
    return 'discarded';
  }

  const LANES_CHOICES: readonly { readonly label: string; readonly lanes: Lanes }[] = [
    { label: 'No lanes', lanes: 'none' },
    { label: 'Systems', lanes: 'systems' },
    { label: 'Services', lanes: 'services' },
  ];

  /** `(lanes)` for the focused diagram, `(documentUri, lanes)` like the other commands, or no argument for a quick pick. */
  async function chooseLanes(argument: unknown, given?: unknown): Promise<boolean> {
    const lanes = typeof argument === 'string' ? argument : given;
    const editor = target(typeof argument === 'string' ? undefined : argument);
    if (!editor) return false;
    if (typeof lanes === 'string' && LANES.includes(lanes as Lanes)) {
      editor.setLanes(lanes as Lanes);
      return true;
    }
    if (!server.flowLanes) {
      void vscode.window.showInformationMessage('The connected ZenWave language server does not draw EventFlow diagrams in lanes.');
      return false;
    }
    const choice = await vscode.window.showQuickPick(LANES_CHOICES, { title: 'EventFlow Lanes', placeHolder: 'Draw the flow in lanes' });
    if (!choice) return false;
    editor.setLanes(choice.lanes);
    return true;
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
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.discardSavedPositions, discardSavedPositions),
    vscode.commands.registerCommand(EVENTFLOW_COMMANDS.lanes, chooseLanes),
    { dispose: () => { for (const editor of [...editors]) editor.dispose(); } },
  );

  return {
    get editors() { return [...editors]; },
    editorsFor: (documentUri) => [...editors].filter((editor) => editor.documentUri === documentUri),
    get active() { return active && editors.has(active) ? active : undefined; },
    get contextViewMode() { return contextViewMode; },
    answerDiscardSavedPositions(answer) {
      const current = { answer, requests: [] as ConfirmationRequest[] };
      answering = current;
      return { requests: current.requests, dispose: () => { if (answering === current) answering = undefined; } };
    },
  };
}
