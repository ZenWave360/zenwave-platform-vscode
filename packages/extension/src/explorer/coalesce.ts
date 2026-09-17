/** Timers, injectable so the coalescing is testable without waiting. */
export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs a refresh after triggers have gone quiet, never two at once, and at most
 * once more for everything that arrived while one was running. A burst of
 * keystrokes is one request, not one per keystroke.
 */
export class CoalescedRefresh {
  private timer: unknown;
  private running: Promise<void> | undefined;
  private again = false;
  private idleWaiters: (() => void)[] = [];
  private disposed = false;
  /** Refreshes actually run; exposed for tests. */
  runs = 0;

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly delayMs: number,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  /** Asks for a refresh; restarts the quiet period. */
  request(delayMs = this.delayMs): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = this.scheduler.set(() => { this.timer = undefined; this.fire(); }, delayMs);
  }

  private fire(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.runs++;
    this.running = this.refresh().catch(() => undefined).then(() => {
      this.running = undefined;
      if (this.again && !this.disposed) {
        this.again = false;
        this.fire();
      } else {
        this.notifyIdle();
      }
    });
  }

  private notifyIdle(): void {
    if (this.timer !== undefined || this.running) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves when nothing is scheduled or running. */
  idle(): Promise<void> {
    if (this.timer === undefined && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get pending(): boolean {
    return this.timer !== undefined || this.running !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
    this.notifyIdle();
  }
}
