import type { Preview, PreviewMode, SequenceRenderMode } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';
import type { StatePresentation } from '../eventflow/protocol.js';
import type { SessionLog } from '../eventflow/session.js';
import {
  DEFAULT_RENDER_MODE,
  inboundMessage,
  type OutboundMessage,
  type PageRepresentation,
  type PreviewProbe,
  type RenderMode,
  type RenderPayload,
} from './protocol.js';
import { reselect } from './selection.js';
import { describePreviewOutcome, presentPreviewState, previewStateFromResult, type PreviewDataState, type PreviewPageState } from './state.js';

export interface PreviewSessionPorts {
  readonly documentUri: string;
  readonly fileName: string;
  /** Whether the document has sequence variants, so the render mode means something for it (ZFL). */
  readonly hasRenderMode: boolean;
  /** `languageServer.requests.preview`. */
  preview(uri: string, sequenceRenderMode?: SequenceRenderMode, mode?: PreviewMode): Promise<RequestResult<Preview>>;
  /** Whether this document can show ZDL Diagrams: a ZDL, and a server that advertised `previewModes` (MP-R25). Asked each time, as the server can reconnect. */
  diagramsAvailable?(): boolean;
  /** `webview.postMessage`. */
  post(message: OutboundMessage): PromiseLike<boolean>;
  /** Runs a command the user chose from a state the editor is showing. */
  runCommand(command: string): void;
  /** `commands.executeCommand('setContext', key, value)`, for the title bar. Applied for the active editor. */
  setContext(key: string, value: boolean): void;
  readonly log: SessionLog;
}

const POSTED_HISTORY = 200;

/** Title-bar and palette `when`: the preview on screen is a Markdown page (MP-R26). */
export const PREVIEW_MARKDOWN_CONTEXT_KEY = 'zenwave.previewMarkdownAvailable';

/**
 * Whether the title bar offers Copy as Markdown: the active editor is a preview and its page is Markdown (MP-R26).
 * Computed from the editor that is active now, not from the last focus event, so the answer cannot go stale.
 */
export function markdownContextValue(activeDocumentUri: string | undefined, previews: Iterable<{ readonly documentUri: string; readonly showsMarkdown: boolean }>): boolean {
  if (activeDocumentUri === undefined) return false;
  for (const preview of previews) if (preview.documentUri === activeDocumentUri) return preview.showsMarkdown;
  return false;
}

/**
 * One preview editor's relay between the language server and the preview page.
 * Holds no editor API, so the rules are unit-tested with fakes.
 *
 * Representations are handled by reference to their `id`, `title`, `format` and
 * `content` only to pass them on. `selection.ts` reads the identifier, to keep
 * the selection (MP-R12). Titles and order are the server's (MP-R4). The page
 * on screen is Markdown when the selected representation's format is, and that
 * content is what Copy as Markdown writes, unchanged (MP-R26).
 */
export class PreviewSession {
  page: PreviewPageState = { kind: 'loading' };
  data: PreviewDataState = { kind: 'loading' };
  renderMode: RenderMode = DEFAULT_RENDER_MODE;
  /** What the preview was asked to show (MP-R25). `diagrams` only takes effect while `diagramsAvailable`. */
  requestedMode: PreviewMode = 'docs';
  /** The id shown now: the last the user chose, or what `reselect` kept. */
  selectedId: string | undefined;
  /** The last good set, in the server's order. */
  representations: readonly PageRepresentation[] = [];
  defaultRepresentationId: string | undefined;
  /** The last `render` payload posted. */
  lastRender: RenderPayload | undefined;
  /** `zenwave/preview` requests issued. */
  requests = 0;
  /** Types of the messages posted, oldest first; bounded. */
  readonly posted: string[] = [];

  private generation = 0;
  private inflight: Promise<void> | undefined;
  private again = false;
  private presented: string | undefined;
  private presentation: StatePresentation | null = null;
  private logged: string | undefined;
  private nextProbe = 1;
  private readonly probes = new Map<number, (probe: PreviewProbe) => void>();
  /** Whether the host was last told that this preview's page is Markdown. */
  private markdownShown = false;
  private disposed = false;

  constructor(private readonly ports: PreviewSessionPorts) {
    this.present(true);
  }

  /** The mode the server is asked for: `diagrams` only when it was chosen and the server can answer it, else today's behaviour. */
  get mode(): PreviewMode {
    return this.requestedMode === 'diagrams' && this.ports.diagramsAvailable?.() === true ? 'diagrams' : 'docs';
  }

  /** The kinds of the set in the server's order, when it is grouped (MP-R25). Empty otherwise. */
  get groups(): readonly string[] {
    const groups: string[] = [];
    for (const item of this.representations) {
      if (item.group !== undefined && !groups.includes(item.group)) groups.push(item.group);
    }
    return groups;
  }

  /** The kind of the representation shown now. */
  get selectedGroup(): string | undefined {
    return this.representations.find((item) => item.id === this.selectedId)?.group;
  }

  get hasPreview(): boolean {
    return this.representations.length > 0;
  }

  /** Whether the page on screen is Markdown (MP-R26). */
  get showsMarkdown(): boolean {
    return this.markdownPage !== undefined;
  }

  /** The Markdown page on screen, exactly as the server sent it. Nothing when the page is not Markdown (MP-R26). */
  get markdownPage(): string | undefined {
    const page = this.representations.find((item) => item.id === this.selectedId);
    return page?.format === 'MARKDOWN' ? page.content : undefined;
  }

  get state(): StatePresentation | null {
    return this.presentation;
  }

  /**
   * Asks the server for the representations and relays the answer. The server answers one request at a time on one
   * thread, so a preview never queues requests behind a running one: a refresh asked meanwhile waits for it, its answer
   * is dropped as stale, and one request for the latest state follows. The promise settles when that last one has.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.request();
        } while (this.again && !this.disposed);
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = run;
    return run;
  }

  private async request(): Promise<void> {
    const generation = ++this.generation;
    this.requests++;
    const mode = this.mode;
    const renderMode = this.ports.hasRenderMode ? this.renderMode : undefined;
    const result = await (mode === 'diagrams'
      ? this.ports.preview(this.ports.documentUri, renderMode, mode)
      : this.ports.preview(this.ports.documentUri, renderMode));
    if (this.disposed || this.again || generation !== this.generation) return;
    const data = previewStateFromResult(result);
    this.record(data);
    this.data = data;
    if (result.kind === 'ok' && result.value.representations.length > 0) {
      const { representations, defaultRepresentationId } = result.value;
      // A grouped set keeps the element only by its exact id: its ids do not name an outcome (MP-R25, MP-R12).
      const choice = reselect(this.selectedId, representations, defaultRepresentationId, mode !== 'diagrams');
      this.representations = representations.map((item) => ({
        id: item.id, title: item.title, format: item.format, content: item.content,
        ...(mode === 'diagrams' && item.group !== undefined ? { group: item.group } : {}),
      }));
      this.defaultRepresentationId = defaultRepresentationId;
      if (choice) {
        if (this.selectedId !== undefined && choice.id !== this.selectedId) {
          this.ports.log.debug(`Preview of ${this.ports.fileName}: ${this.selectedId} is gone; showing ${choice.id} (${choice.reason})`);
        }
        this.selectedId = choice.id;
      }
      this.renderIfReady();
    }
    this.present();
    this.updateMarkdownContext();
  }

  /** Shows another representation. Answers whether the id is one of the current set. */
  selectRepresentation(id: string): boolean {
    if (!this.representations.some((item) => item.id === id)) return false;
    if (this.selectedId === id) return true;
    this.selectedId = id;
    this.renderIfReady();
    this.updateMarkdownContext();
    return true;
  }

  /** Shows the first element of a kind (MP-R25). Answers whether the set has that kind. */
  selectGroup(group: string): boolean {
    const first = this.representations.find((item) => item.group === group);
    if (!first) return false;
    if (this.selectedGroup === group) return true;
    return this.selectRepresentation(first.id);
  }

  /** Chooses between the page and the diagrams (MP-R25) and asks the server again. Answers false when diagrams cannot be offered. */
  async setPreviewMode(mode: PreviewMode): Promise<boolean> {
    if (mode === 'diagrams' && this.ports.diagramsAvailable?.() !== true) {
      this.ports.log.info(`Preview of ${this.ports.fileName}: ZDL Diagrams needs a server that advertises previewModes`);
      return false;
    }
    if (this.requestedMode === mode) return true;
    this.requestedMode = mode;
    this.selectedId = undefined;
    this.representations = [];
    this.updateMarkdownContext();
    await this.refresh();
    return true;
  }

  /**
   * Copies the Markdown page on screen through `writeText` (the host clipboard),
   * exactly as the server sent it. A diagram page copies nothing (MP-R26).
   */
  async copyMarkdown(writeText: (text: string) => PromiseLike<void>): Promise<boolean> {
    const content = this.markdownPage;
    if (content === undefined) return false;
    await writeText(content);
    return true;
  }

  /** Changes how sequence variants are rendered and asks the server again with the new mode (MP-R11). */
  async setRenderMode(mode: RenderMode): Promise<void> {
    if (!this.ports.hasRenderMode || this.renderMode === mode) return;
    this.renderMode = mode;
    this.renderIfReady();
    await this.refresh();
  }

  /** Something the webview posted. */
  receive(raw: unknown): void {
    const message = inboundMessage(raw);
    if (!message || this.disposed) return;
    switch (message.type) {
      case 'zenwave.preview.ready':
        this.page = { kind: 'ready' };
        this.ports.log.info(`Preview of ${this.ports.fileName}: page loaded`);
        this.renderIfReady();
        this.present(true);
        return;
      case 'zenwave.preview.selectRepresentation':
        this.selectRepresentation(message.payload.id);
        return;
      case 'zenwave.preview.selectGroup':
        this.selectGroup(message.payload.group);
        return;
      case 'zenwave.preview.selectRenderMode':
        void this.setRenderMode(message.payload.mode);
        return;
      case 'zenwave.preview.diagramFailed':
        this.ports.log.warn(`Preview of ${this.ports.fileName}: ${message.payload.id} could not be drawn: ${message.payload.message}`);
        return;
      case 'zenwave.host.loadError':
        if (this.page.kind === 'ready') {
          this.ports.log.warn(`Preview of ${this.ports.fileName}: page error: ${message.payload.message}`);
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

  /** The page cannot be shown: says so instead of leaving a blank editor. */
  pageFailed(message: string): void {
    this.page = { kind: 'failed', message };
    this.ports.log.warn(`Preview of ${this.ports.fileName}: the page failed to load: ${message}`);
    this.present(true);
  }

  /** Asks the page what it rendered. With `followLink`, the page first follows that `#anchor` link as a click would (a test seam: a host cannot click inside a webview). */
  probe(followLink?: string, copyMermaid?: number, timeoutMs = 5000): Promise<PreviewProbe> {
    const requestId = this.nextProbe++;
    return new Promise<PreviewProbe>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(requestId);
        reject(new Error(`The preview page did not answer probe ${requestId}`));
      }, timeoutMs);
      this.probes.set(requestId, (probe) => { clearTimeout(timer); resolve(probe); });
      this.post({ type: 'zenwave.host.probe', payload: { requestId, ...(followLink === undefined ? {} : { followLink }), ...(copyMermaid === undefined ? {} : { copyMermaid }) } });
    });
  }

  /**
   * Runs from the panel's disposal, when the host throws for anything asked of the panel, so nothing is published
   * here: the host clears the title-bar key when the active preview closes (feature.ts).
   */
  dispose(): void {
    this.disposed = true;
    this.probes.clear();
  }

  private renderIfReady(): void {
    if (this.page.kind !== 'ready' || this.selectedId === undefined || !this.hasPreview) return;
    const payload: RenderPayload = {
      representations: this.representations,
      selectedId: this.selectedId,
      renderMode: this.renderMode,
      showRenderMode: this.ports.hasRenderMode,
      groups: this.groups,
      ...(this.selectedGroup === undefined ? {} : { selectedGroup: this.selectedGroup }),
    };
    this.lastRender = payload;
    this.post({ type: 'zenwave.preview.render', payload });
  }

  private record(data: PreviewDataState): void {
    const line = describePreviewOutcome(this.ports.fileName, data);
    if (line === this.logged) this.ports.log.debug(line);
    else if (data.kind === 'rendered') this.ports.log.info(line);
    else this.ports.log.warn(line);
    this.logged = line;
  }

  /** Sends the state to show when it changed, or always when `force` (the page may have just started listening). */
  private present(force = false): void {
    const presentation = presentPreviewState(this.ports.fileName, this.page, this.data, this.hasPreview && this.page.kind === 'ready');
    const key = JSON.stringify(presentation);
    this.presentation = presentation;
    if (!force && key === this.presented) return;
    this.presented = key;
    this.post({ type: 'zenwave.host.state', payload: presentation });
  }

  /** Tells the host when whether the page on screen is Markdown changes; the host decides what the title bar shows (MP-R26). */
  private updateMarkdownContext(): void {
    const showing = this.markdownPage !== undefined;
    if (showing === this.markdownShown) return;
    this.markdownShown = showing;
    this.ports.setContext(PREVIEW_MARKDOWN_CONTEXT_KEY, showing);
  }

  private post(message: OutboundMessage): void {
    this.posted.push(message.type);
    if (this.posted.length > POSTED_HISTORY) this.posted.splice(0, this.posted.length - POSTED_HISTORY);
    void Promise.resolve(this.ports.post(message)).then(undefined, () => undefined);
  }
}
