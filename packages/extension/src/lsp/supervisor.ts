/** Host adapters own IPC/Worker APIs; shared feature code only sees this surface. */
export interface LspTransport {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  sendRequest(method: string, params: unknown): Promise<unknown>;
  onDidExit(listener: (reason: string) => void): { dispose(): void };
}

export interface LspLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LspState =
  | { readonly kind: 'unavailable' | 'failed'; readonly reason: string }
  | { readonly kind: 'starting' | 'connected' | 'stopping' };

export type RequestResult<T = unknown> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'no-server'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly method: string }
  | FailedRequest;

/**
 * A request the server answered with an error. `code` and `data` are the
 * JSON-RPC error's, when the transport reported one — `data.kind` is how the
 * ZenWave requests say *why* (`documentUnreadable`, `documentNotFound`, …).
 */
export interface FailedRequest {
  readonly kind: 'failed';
  readonly reason: string;
  readonly code?: number;
  readonly data?: unknown;
}

/** JSON-RPC "method not found": a server too old for the request, not a failure. */
export const METHOD_NOT_FOUND = -32601;

interface Session {
  readonly transport: LspTransport;
  readonly ended: AbortController;
  readonly exit: { dispose(): void };
  requests: ReadonlySet<string>;
  initializeResult: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Matches the existing initialize response in ZenwaveLspServer.buildCapabilities. */
export function advertisedRequests(initializeResult: unknown): ReadonlySet<string> {
  const capabilities = object(object(initializeResult)?.capabilities);
  const experimental = object(capabilities?.experimental);
  const requests = experimental?.customRequests;
  return new Set(Array.isArray(requests)
    ? requests.filter((value): value is string => typeof value === 'string' && value.startsWith('zenwave/'))
    : []);
}

/** Reads a JSON-RPC error's code and data without depending on a transport's error class. */
export function responseError(error: unknown): { code?: number; data?: unknown } {
  const value = object(error);
  const code = typeof value?.code === 'number' ? value.code : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(value && value.data !== undefined ? { data: value.data } : {}),
  };
}

type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failed'; reason: string; error: unknown }
  | { kind: 'ended' }
  | { kind: 'timeout' };

/** Ends abandoned requests promptly, even if the underlying transport never rejects. */
async function bounded<T>(action: () => Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error('Transport operation was cancelled');
        return action();
      }).then(
        (value): Outcome<T> => ({ kind: 'ok', value }),
        (error: unknown): Outcome<T> => ({ kind: 'failed', reason: error instanceof Error ? error.message : 'Transport operation failed', error }),
      ),
      new Promise<Outcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), milliseconds);
        onAbort = () => resolve({ kind: 'ended' });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** One lifecycle and request gate shared by all server-backed features. */
export class LspSupervisor {
  private current: Session | undefined;
  private queue = Promise.resolve();
  private stopGeneration = 0;
  private stateValue: LspState;
  private readonly listeners = new Set<(state: LspState) => void>();

  constructor(
    private readonly factory: (() => LspTransport) | undefined,
    private readonly log: LspLog,
    private readonly timeoutMs = 30000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('LSP timeout must be positive');
    this.stateValue = { kind: 'unavailable', reason: factory ? 'Language server has not started' : 'No language server transport is available in this build' };
  }

  get state(): LspState { return this.stateValue; }

  onDidChangeState(listener: (state: LspState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** The `zenwave/*` requests the connected server advertised; empty when none is connected. */
  get advertisedRequests(): ReadonlySet<string> {
    return this.state.kind === 'connected' ? this.current?.requests ?? new Set() : new Set();
  }

  /** The connected server's initialize result, unchanged. */
  get initializeResult(): unknown {
    return this.state.kind === 'connected' ? this.current?.initializeResult : undefined;
  }

  supports(method: string): boolean {
    return this.state.kind === 'connected' && (this.current?.requests.has(method) ?? false);
  }

  start(): Promise<void> {
    const generation = this.stopGeneration;
    return this.enqueue(() => generation === this.stopGeneration ? this.startSession(generation) : Promise.resolve());
  }

  stop(): Promise<void> {
    // Cancel startup and requests before waiting for a queued lifecycle operation.
    this.stopGeneration++;
    this.current?.ended.abort();
    return this.enqueue(async () => {
      const session = this.current;
      if (session) {
        this.setState({ kind: 'stopping' });
        await this.close(session);
      }
      this.setState({ kind: 'unavailable', reason: 'Language server is stopped' });
    });
  }

  async restart(): Promise<void> { await this.stop(); await this.start(); }

  async request(method: string, params: unknown): Promise<RequestResult> {
    const session = this.current;
    if (!session || this.state.kind !== 'connected' || session.ended.signal.aborted) return this.unavailable();
    if (!session.requests.has(method)) {
      this.log.warn(`Language server does not advertise ${method}`);
      return { kind: 'unsupported', method };
    }
    const result = await bounded(() => session.transport.sendRequest(method, params), this.timeoutMs, session.ended.signal);
    if (this.current !== session || session.ended.signal.aborted || result.kind === 'ended') return this.unavailable();
    if (result.kind === 'ok') return { kind: 'ok', value: result.value };
    if (result.kind === 'timeout') {
      const reason = `Language server request ${method} timed out`;
      this.log.error(`Language server request ${method} failed: ${reason}`);
      return { kind: 'failed', reason };
    }
    const { code, data } = responseError(result.error);
    if (code === METHOD_NOT_FOUND) {
      this.log.warn(`Language server advertised ${method} but does not implement it`);
      return { kind: 'unsupported', method };
    }
    this.log.error(`Language server request ${method} failed: ${result.reason}`);
    return {
      kind: 'failed',
      reason: result.reason,
      ...(code === undefined ? {} : { code }),
      ...(data === undefined ? {} : { data }),
    };
  }

  private unavailable(): RequestResult<never> {
    return { kind: 'no-server', reason: 'reason' in this.state ? this.state.reason : `Language server is ${this.state.kind}` };
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(action);
    // A rejected operation must not poison subsequent restart attempts.
    this.queue = pending.catch(() => {});
    return pending;
  }

  private setState(state: LspState): void {
    this.stateValue = state;
    this.log.info(`Language server: ${state.kind}${'reason' in state ? ` (${state.reason})` : ''}`);
    for (const listener of this.listeners) {
      try { listener(state); } catch { this.log.warn('Language server state observer failed'); }
    }
  }

  private async startSession(generation: number): Promise<void> {
    if (!this.factory || this.current) return;
    this.setState({ kind: 'starting' });
    if (generation !== this.stopGeneration) return;
    let session: Session | undefined;
    try {
      const transport = this.factory();
      const ended = new AbortController();
      const exit = transport.onDidExit((reason) => {
        if (!session || this.current !== session || ended.signal.aborted) return;
        ended.abort();
        this.current = undefined;
        exit.dispose();
        this.setState({ kind: 'failed', reason });
        this.log.error(`Language server stopped unexpectedly: ${reason}`);
      });
      session = { transport, ended, exit, requests: new Set(), initializeResult: undefined };
      this.current = session;
      if (generation !== this.stopGeneration) ended.abort();
      const result = await bounded(() => transport.start(), this.timeoutMs, ended.signal);
      if (result.kind === 'ended' || this.current !== session) return;
      if (result.kind !== 'ok') throw new Error(result.kind === 'timeout' ? 'Language server startup timed out' : result.reason);
      session.requests = advertisedRequests(result.value);
      session.initializeResult = result.value;
      this.setState({ kind: 'connected' });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Language server failed to start';
      this.setState({ kind: 'failed', reason });
      this.log.error(`Language server failed to start: ${reason}`);
      if (session) await this.close(session);
    }
  }

  private async close(session: Session): Promise<void> {
    if (this.current === session) this.current = undefined;
    session.ended.abort();
    session.exit.dispose();
    const result = await bounded(() => session.transport.stop(), this.timeoutMs);
    if (result.kind !== 'ok') this.log.warn(`Language server cleanup ${result.kind}`);
  }
}
