import { INVALID_PARAMS, type EventFlowViews } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';
import { dataStateFromResult, describeOutcome, presentState, type DataState, type PageState } from './diagram-state.js';
import {
  inboundMessage,
  readiness,
  type DisplaySettings,
  type OutboundMessage,
  type PageMessage,
  type PageProbe,
  type StatePresentation,
  type ViewMode,
} from './protocol.js';
import { serializePositions, type Positions, type PositionsFile } from './positions.js';

export interface SessionLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface SessionPorts {
  readonly documentUri: string;
  readonly fileName: string;
  /** The open text model's version; unavailable documents must always be retried. */
  documentVersion(): number | undefined;
  /** `languageServer.requests.eventFlowViews`. */
  eventFlowViews(uri: string, variant?: string, positions?: Positions): Promise<RequestResult<EventFlowViews>>;
  /** Whether the connected server advertised `flowVariants`. */
  flowVariants(): boolean;
  /** Whether the connected server advertised `savedPositions`. */
  savedPositions(): boolean;
  /** The positions file beside the model (EF-R14). */
  readonly positionsFile: {
    read(): Promise<PositionsFile>;
    /** `read-only` when the workspace cannot be written; the user has been told. */
    write(positions: Positions): Promise<'written' | 'read-only'>;
    remove(): Promise<void>;
  };
  /** `webview.postMessage`. */
  post(message: OutboundMessage): PromiseLike<boolean>;
  /** Runs a command the user chose from a state the editor is showing. */
  runCommand(command: string): void;
  readonly log: SessionLog;
  /** Tells the user something went wrong with a thing they asked for. */
  warn(message: string): void;
  /** The answer to `savedPositionsExist` may have changed. */
  positionsExistChanged(): void;
}

export type RenderBundlePayload = Extract<PageMessage, { type: 'renderBundle' }>['payload'];

const POSTED_HISTORY = 200;

function stateOf(file: PositionsFile): string {
  if (!file.exists) return 'absent';
  return file.positions ? serializePositions(file.positions) : `invalid ${file.why ?? ''}`;
}

/** `applied` and `missing` as the server answered; not applied when no file's positions were sent. */
function savedAnswer(sent: boolean, views: EventFlowViews): { applied: boolean; missing?: readonly string[] } {
  const answer = sent ? views.savedPositions : undefined;
  if (answer?.applied === true) return { applied: true };
  return { applied: false, ...(answer?.applied === false && answer.missing ? { missing: answer.missing } : {}) };
}

/**
 * One diagram editor's relay between the language server and the EventFlow page.
 * Holds no editor API, so the relay rules are unit-tested with fakes.
 *
 * The view model is handled only by reference: the server's `flowGraph` and
 * `serviceGraph` are put into `renderBundle` as they arrived, and nothing here
 * reads a property of either.
 */
export class DiagramSession {
  page: PageState = { kind: 'loading' };
  data: DataState = { kind: 'loading' };
  viewMode: ViewMode;
  displaySettings: DisplaySettings;
  /** The payload of the last `webviewReady`, as the page sent it. */
  readyPayload: unknown;
  /** The last `renderBundle` payload posted. */
  lastRenderBundle: RenderBundlePayload | undefined;
  /** Types of the messages posted, oldest first; bounded. */
  readonly posted: string[] = [];
  /** `eventFlowViews` requests issued. */
  requests = 0;
  private lastGood: EventFlowViews | undefined;
  /** What the page is told about the positions file, for the full diagram when the server applies saved positions. */
  private lastSaved: RenderBundlePayload['savedPositions'];
  private fileExists = false;
  /** The state of the positions file as this session last read or wrote it, to tell its own writes from outside changes. */
  private fileState: string | undefined;
  private positionsReadable = true;
  private lastRefreshKey: string | undefined;
  private loggedFileProblem: string | undefined;
  /** The variant the user chose in this editor, or `null` for the full diagram. Not persisted (EF-R12). */
  private variant: string | null = null;
  /** Whether the page has been sent the last good diagram. */
  private rendered = false;
  private highlight: string | null = null;
  private generation = 0;
  private presented: string | undefined;
  private presentation: StatePresentation | null = null;
  private logged: string | undefined;
  private nextProbe = 1;
  private readonly probes = new Map<number, (probe: PageProbe) => void>();
  private disposed = false;

  constructor(private readonly ports: SessionPorts, initial: { readonly viewMode: ViewMode; readonly displaySettings: DisplaySettings }) {
    this.viewMode = initial.viewMode;
    this.displaySettings = initial.displaySettings;
    this.present(true);
  }

  get hasDiagram(): boolean {
    return this.lastGood !== undefined;
  }

  get state(): StatePresentation | null {
    return this.presentation;
  }

  /** Whether a positions file was beside the model at the last request. */
  get savedPositionsExist(): boolean {
    return this.fileExists;
  }

  /** Server lifecycle changes must retry even when the document did not change. */
  invalidateRefresh(): void {
    this.lastRefreshKey = undefined;
    ++this.generation;
  }

  /** Asks the server for the view model and relays the answer. Answers overtaken by a newer request are dropped. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const version = this.ports.documentVersion();
    const withVariants = this.ports.flowVariants();
    const withPositions = this.ports.savedPositions();
    const file = withPositions ? await this.readPositionsFile() : undefined;
    if (this.disposed || generation !== this.generation) return;
    const refreshKey = (): string | undefined => version === undefined || (withPositions && !this.positionsReadable)
      ? undefined
      : JSON.stringify([version, this.variant, this.viewMode, this.displaySettings.humanizeLabels, withPositions ? this.fileState : null]);
    let key = refreshKey();
    if (key !== undefined && key === this.lastRefreshKey) return;
    // A failed refresh must be retried, including when the text returns to an older successful version.
    this.lastRefreshKey = undefined;
    let { result, saved } = await this.askServer(withVariants, file);
    if (this.disposed || generation !== this.generation) return;
    if (withVariants && this.variant !== null && result.kind === 'failed' && result.code === INVALID_PARAMS) {
      // The variant is gone from the document: show the full diagram.
      this.ports.log.info(`EventFlow diagram for ${this.ports.fileName}: variant "${this.variant}" no longer exists; showing the full diagram`);
      this.variant = null;
      key = refreshKey();
      ({ result, saved } = await this.askServer(withVariants, file));
      if (this.disposed || generation !== this.generation) return;
    }
    const data = dataStateFromResult(result);
    this.record(data);
    this.data = data;
    if (result.kind === 'ok') {
      this.lastRefreshKey = key;
      this.lastGood = result.value;
      this.lastSaved = saved && { exists: saved.exists, ...savedAnswer(saved.sent, result.value) };
      this.rendered = false;
      this.renderIfReady();
    }
    this.present();
  }

  private async askServer(withVariants: boolean, file?: PositionsFile): Promise<{ result: RequestResult<EventFlowViews>; saved?: { exists: boolean; sent: boolean } }> {
    if (withVariants && this.variant !== null) {
      // No positions are sent for a variant; the file was still read for Discard Saved Positions.
      this.requests++;
      return { result: await this.ports.eventFlowViews(this.ports.documentUri, this.variant) };
    }
    if (!file) {
      this.requests++;
      return { result: await this.ports.eventFlowViews(this.ports.documentUri) };
    }
    this.requests++;
    const result = await this.ports.eventFlowViews(this.ports.documentUri, undefined, file.positions);
    return { result, saved: { exists: file.exists, sent: file.positions !== undefined } };
  }

  private async readPositionsFile(): Promise<PositionsFile> {
    let file: PositionsFile;
    this.positionsReadable = true;
    try {
      file = await this.ports.positionsFile.read();
    } catch (error) {
      this.positionsReadable = false;
      this.ports.log.warn(`EventFlow diagram for ${this.ports.fileName}: could not read the positions file: ${error instanceof Error ? error.message : String(error)}`);
      file = { exists: false };
    }
    const before = this.fileExists;
    this.fileExists = file.exists;
    this.fileState = stateOf(file);
    if (before !== file.exists) this.ports.positionsExistChanged();
    const problem = file.exists && file.positions === undefined ? file.why ?? 'it cannot be applied' : undefined;
    if (problem !== undefined && problem !== this.loggedFileProblem) {
      this.ports.log.warn(`EventFlow diagram for ${this.ports.fileName}: the saved positions file is ignored: ${problem}`);
    }
    this.loggedFileProblem = problem;
    return file;
  }

  /** Something the webview posted. */
  receive(raw: unknown): void {
    const message = inboundMessage(raw);
    if (!message || this.disposed) return;
    switch (message.type) {
      case 'webviewReady': {
        this.readyPayload = message.payload;
        const ready = readiness(message.payload);
        if (ready.kind === 'mismatch') {
          this.pageFailed(ready.message);
          return;
        }
        this.page = { kind: 'ready', protocolVersion: ready.protocolVersion };
        this.ports.log.info(`EventFlow diagram for ${this.ports.fileName}: page loaded (protocol version ${ready.protocolVersion})`);
        this.renderIfReady();
        this.present(true);
        return;
      }
      case 'variantChanged':
        if (this.ports.flowVariants() && message.payload.variant !== this.variant) {
          this.variant = message.payload.variant;
          void this.refresh();
        }
        return;
      case 'savePositions':
        if (!this.ports.savedPositions() || this.variant !== null) {
          this.ports.log.info(`EventFlow diagram for ${this.ports.fileName}: positions are saved only from the full diagram of a server that applies them; ignored`);
          return;
        }
        void this.savePositions(message.payload.positions);
        return;
      case 'viewModeChanged':
        // The page already shows this view: record it without telling the page (EF-R3).
        this.viewMode = message.payload.viewMode;
        return;
      case 'labelsChanged':
        this.setDisplaySettings({ humanizeLabels: message.payload.humanize });
        return;
      case 'zenwave.host.loadError':
        if (this.page.kind === 'ready') {
          this.ports.log.warn(`EventFlow diagram for ${this.ports.fileName}: page error: ${message.payload.message}`);
        } else {
          this.pageFailed(message.payload.message);
        }
        return;
      case 'zenwave.host.action':
        // Only an action the editor is offering right now can be run from the page.
        if (this.presentation?.actions.some((action) => action.command === message.payload.command)) {
          this.ports.runCommand(message.payload.command);
        }
        return;
      case 'zenwave.host.probeResult': {
        const resolve = this.probes.get(message.payload.requestId);
        this.probes.delete(message.payload.requestId);
        resolve?.(message.payload);
        return;
      }
    }
  }

  private async savePositions(positions: Positions): Promise<void> {
    try {
      if (await this.ports.positionsFile.write(positions) === 'written') {
        // The file watcher reports this write too; the refresh below already covers it.
        this.fileState = serializePositions(positions);
        await this.refresh();
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.ports.log.warn(`EventFlow diagram for ${this.ports.fileName}: could not save the positions: ${why}`);
      this.ports.warn(`The positions of ${this.ports.fileName} were not saved: ${why}`);
    }
  }

  /**
   * The positions file changed on disk. True when the diagram should be asked for again: a change this session
   * did not make itself (a branch switch, another editor). Its own writes and deletes are already refreshed.
   */
  async positionsFileChanged(): Promise<boolean> {
    if (this.disposed || !this.ports.savedPositions()) return false;
    let state: string;
    try {
      state = stateOf(await this.ports.positionsFile.read());
    } catch {
      return true;
    }
    return state !== this.fileState;
  }

  /** Deletes the positions file and asks again, so the diagram is laid out automatically (EF-Q9). */
  async discardSavedPositions(): Promise<void> {
    await this.ports.positionsFile.remove();
    this.fileState = 'absent';
    await this.refresh();
  }

  /** The page did not say it loaded in time. */
  pageTimedOut(seconds: number): void {
    if (this.page.kind === 'loading') this.pageFailed(`The page did not report that it loaded within ${seconds} seconds.`);
  }

  setViewMode(viewMode: ViewMode): void {
    if (this.viewMode === viewMode) return;
    this.viewMode = viewMode;
    if (this.rendered) this.post({ type: 'setViewMode', payload: { viewMode } });
  }

  setDisplaySettings(displaySettings: DisplaySettings): void {
    if (this.displaySettings.humanizeLabels === displaySettings.humanizeLabels) return;
    this.displaySettings = displaySettings;
    if (this.rendered) this.post({ type: 'setDisplaySettings', payload: { displaySettings } });
  }

  /** The node id last asked to be highlighted, or `null`. */
  get highlighted(): string | null {
    return this.highlight;
  }

  /** Highlights a flow node, or clears the highlight; applied once a diagram is on the page. */
  highlightNode(nodeId: string | null): void {
    this.highlight = nodeId;
    if (this.rendered) this.post({ type: 'highlightNode', payload: { nodeId } });
  }

  /** Clicks the page's view selector through the host script. For tests; a page without a selector ignores it. */
  selectView(viewMode: ViewMode): void {
    this.post({ type: 'zenwave.host.selectView', payload: { viewMode } });
  }

  /** Asks the host script what the page rendered. */
  probe(timeoutMs = 5000): Promise<PageProbe> {
    const requestId = this.nextProbe++;
    return new Promise<PageProbe>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(requestId);
        reject(new Error(`The EventFlow page did not answer probe ${requestId}`));
      }, timeoutMs);
      this.probes.set(requestId, (probe) => { clearTimeout(timer); resolve(probe); });
      this.post({ type: 'zenwave.host.probe', payload: { requestId } });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.probes.clear();
  }

  private renderIfReady(): void {
    if (this.page.kind !== 'ready' || !this.lastGood || this.rendered) return;
    const payload: RenderBundlePayload = {
      flowGraph: this.lastGood.flowGraph,
      serviceGraph: this.lastGood.serviceGraph,
      viewMode: this.viewMode,
      displaySettings: this.displaySettings,
      diagramId: this.ports.documentUri,
      ...(this.ports.flowVariants() ? { variants: this.lastGood.variants ?? [], variant: this.variant } : {}),
      ...(this.lastSaved ? { savedPositions: this.lastSaved } : {}),
    };
    this.lastRenderBundle = payload;
    this.rendered = true;
    this.post({ type: 'renderBundle', payload });
    if (this.highlight !== null) this.post({ type: 'highlightNode', payload: { nodeId: this.highlight } });
  }

  /** The page cannot be shown: says so instead of leaving a blank editor. */
  pageFailed(message: string): void {
    this.page = { kind: 'failed', message };
    this.ports.log.warn(`EventFlow diagram for ${this.ports.fileName}: the page failed to load: ${message}`);
    this.present(true);
  }

  private record(data: DataState): void {
    const line = describeOutcome(this.ports.fileName, data);
    if (line === this.logged) this.ports.log.debug(line);
    else if (data.kind === 'rendered') this.ports.log.info(line);
    else this.ports.log.warn(line);
    this.logged = line;
  }

  /** Sends the state to show when it changed, or always when `force` (the page may have just started listening). */
  private present(force = false): void {
    const presentation = presentState(this.ports.fileName, this.page, this.data, this.hasDiagram && this.page.kind === 'ready');
    const key = JSON.stringify(presentation);
    this.presentation = presentation;
    if (!force && key === this.presented) return;
    this.presented = key;
    this.post({ type: 'zenwave.host.state', payload: presentation });
  }

  private post(message: OutboundMessage): void {
    this.posted.push(message.type);
    if (this.posted.length > POSTED_HISTORY) this.posted.splice(0, this.posted.length - POSTED_HISTORY);
    void Promise.resolve(this.ports.post(message)).then(undefined, () => undefined);
  }
}
