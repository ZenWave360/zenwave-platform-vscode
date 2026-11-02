// A local smoke run has no CI timeout-minutes. test-web never settles when the page answers 500, and
// test-electron never settles when the editor does not exit. The deadline rejects; the caller still runs its
// cleanup and then exits, because the server, browser or editor can keep the process alive after the rejection.

const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;

export function smokeTimeoutMs(env = process.env) {
  const raw = env.ZENWAVE_SMOKE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SMOKE_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_TIMEOUT_MS) {
    throw new Error(
      `ZENWAVE_SMOKE_TIMEOUT_MS must be a positive integer number of milliseconds up to ${MAX_TIMEOUT_MS}, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

export class SmokeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmokeTimeoutError';
  }
}

export async function withDeadline(work, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SmokeTimeoutError(message)), timeoutMs);
  });
  // Once the deadline wins, a later rejection of the original work must not surface as unhandled.
  work.then(() => {}, () => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
