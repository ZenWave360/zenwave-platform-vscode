import type { EventFlowViews } from '../lsp/requests.js';
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

export interface SessionLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface SessionPorts {
  readonly documentUri: string;
  readonly fileName: string;
  /** `languageServer.requests.eventFlowViews`. */
  eventFlowViews(uri: string): Promise<RequestResult<EventFlowViews>>;
  /** `webview.postMessage`. */
  post(message: OutboundMessage): PromiseLike<boolean>;
  /** Runs a command the user chose from a state the editor is showing. */
  runCommand(command: string): void;
  readonly log: SessionLog;
}

export type RenderBundlePayload = Extract<PageMessage, { type: 'renderBundle' }>['payload'];

const POSTED_HISTORY = 200;

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

  /** Asks the server for the view model and relays the answer. Answers overtaken by a newer request are dropped. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.requests++;
    const result = await this.ports.eventFlowViews(this.ports.documentUri);
    if (this.disposed || generation !== this.generation) return;
    const data = dataStateFromResult(result);
    this.record(data);
    this.data = data;
    if (result.kind === 'ok') {
      this.lastGood = result.value;
      this.rendered = false;
      this.renderIfReady();
    }
    this.present();
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
