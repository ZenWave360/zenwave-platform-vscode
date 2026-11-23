/**
 * Waiting on a host outline or a hierarchy without holding the tree's single
 * refresh open after the user has moved on. A Markdown document-symbol provider
 * often registers only after the file is shown, and one empty answer is not
 * proof that the document has no outline. The wait is editor-API-free so the
 * race is unit-testable.
 */

export type Settled<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'stale' }
  | { readonly kind: 'rejected'; readonly error: unknown };

export type OutlineWait<T> =
  | { readonly kind: 'symbols'; readonly symbols: readonly T[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface OutlineWaitOptions<T> {
  /** One ask of the host provider. `undefined` and `[]` are both an empty answer. */
  ask: () => Promise<readonly T[] | undefined>;
  /** Invoked at most once, after the first empty answer. */
  activate?: () => Promise<unknown>;
  deadlineMs: number;
  /** How often a hung ask notices that the target moved, or that the tree was disposed. */
  pollMs: number;
  /**
   * First pause after an empty or failed answer. Doubles after each pause up to
   * `maxIntervalMs`. Defaults to `pollMs`; without a larger `maxIntervalMs` the
   * pause stays that length.
   */
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  /** The tree's target changed, or the tree was disposed; the wait must end. */
  stale?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Resolves with the value, with `stale` once `stale()` is true, or with the
 * rejection. A late settle after that is ignored, including a late rejection,
 * so a command that never answers cannot reject afterwards on the event loop.
 * An already settled `pending` wins over the first poll.
 */
export function untilSettledOrStale<T>(
  pending: PromiseLike<T>,
  stale: () => boolean,
  pollMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: Settled<T>): void => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    const consider = (value: Settled<T>): void => {
      finish(stale() ? { kind: 'stale' } : value);
    };
    Promise.resolve(pending).then(
      (value) => consider({ kind: 'value', value }),
      (error: unknown) => consider({ kind: 'rejected', error }),
    );
    const poll = (): void => {
      if (finished) return;
      if (stale()) {
        finish({ kind: 'stale' });
        return;
      }
      void sleep(pollMs).then(() => {
        if (finished) return;
        poll();
      });
    };
    // A value that is already there is delivered on the microtask queued above.
    void Promise.resolve().then(() => { if (!finished) poll(); });
  });
}

/**
 * Asks until the provider returns symbols, the deadline passes, or the target
 * changes. An empty answer is retried with backoff: for Markdown that is the
 * provider not being registered yet, and the next ask sees it once it is. The
 * wait stops at the first non-empty outline, so a heading-less file is not
 * asked on every stale poll. One hung ask does not restart the deadline.
 * `activate` runs once and is not gated on the extension already reporting
 * itself active.
 */
export async function waitForOutline<T>(options: OutlineWaitOptions<T>): Promise<OutlineWait<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const targetStale = options.stale ?? (() => false);
  const started = now();
  const pastDeadline = (): boolean => now() - started >= options.deadlineMs;
  const giveUp = (): boolean => targetStale() || pastDeadline();
  let intervalMs = options.initialIntervalMs ?? options.pollMs;
  const maxIntervalMs = options.maxIntervalMs ?? intervalMs;
  let activated = false;
  let sawEmpty = false;
  let failure: string | undefined;

  /** True when the wait must end because the tree moved on or was disposed. */
  const pause = async (): Promise<boolean> => {
    const remaining = options.deadlineMs - (now() - started);
    if (remaining <= 0) return targetStale();
    const waitMs = Math.min(intervalMs, remaining);
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    const until = now() + waitMs;
    while (!giveUp() && now() < until) {
      const slice = Math.min(options.pollMs, until - now());
      if (slice <= 0) break;
      await sleep(slice);
    }
    return targetStale();
  };

  while (!pastDeadline()) {
    if (targetStale()) return { kind: 'stale' };
    const outcome = await untilSettledOrStale(options.ask(), giveUp, options.pollMs, sleep);
    if (targetStale()) return { kind: 'stale' };
    if (outcome.kind === 'rejected') {
      failure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      if (pastDeadline()) break;
      if (await pause()) return { kind: 'stale' };
      continue;
    }
    if (outcome.kind === 'value') {
      const symbols = outcome.value ?? [];
      if (symbols.length > 0) return { kind: 'symbols', symbols };
      sawEmpty = true;
    } else if (pastDeadline()) {
      break;
    }
    if (!activated && options.activate) {
      activated = true;
      const activation = await untilSettledOrStale(options.activate(), giveUp, options.pollMs, sleep);
      if (targetStale()) return { kind: 'stale' };
      if (activation.kind === 'rejected') {
        failure = activation.error instanceof Error ? activation.error.message : String(activation.error);
      } else if (activation.kind === 'stale') {
        break;
      }
    }
    if (pastDeadline()) break;
    if (await pause()) return { kind: 'stale' };
  }

  if (targetStale()) return { kind: 'stale' };
  if (!sawEmpty && failure !== undefined) return { kind: 'failed', reason: failure };
  return sawEmpty ? { kind: 'empty' } : { kind: 'unanswered' };
}
