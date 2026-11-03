// A local smoke run has no CI timeout-minutes. test-web never settles when the page answers 500, and
// test-electron never settles when the editor does not exit. The deadline rejects; the caller still runs its
// cleanup and then exits, because the server, browser or editor can keep the process alive after the rejection.
// test-electron kills the editor only when this process receives SIGINT, so a timeout has to kill that tree first.
// finishSmoke is that order. A cleanup failure after a timeout is reported and does not skip that kill or that exit.
// A normal failure only sets a failure code, so the process can end on its own. A cleanup failure then may propagate.

import { spawn } from 'node:child_process';

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

const defaultKillDeps = {
  spawn,
  kill(pid, signal) {
    process.kill(pid, signal);
  },
};

/**
 * Stop `pid` and the processes it started.
 * Windows: `taskkill /PID <pid> /T /F`. Elsewhere the pid leads a process group, and the group is killed.
 * Resolves when the kill has finished, so the caller can exit afterwards.
 */
export async function killProcessTree(pid, platform = process.platform, deps = defaultKillDeps) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`A process id to kill must be a positive integer, got ${JSON.stringify(pid)}`);
  }
  if (platform === 'win32') {
    await new Promise((resolve, reject) => {
      const child = deps.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(`taskkill /PID ${pid} /T /F exited ${code}`));
      });
    });
    return;
  }
  deps.kill(-pid, 'SIGKILL');
}

function isEditorLaunch(args) {
  return Array.isArray(args) && args.some((arg) =>
    typeof arg === 'string' && (arg === '--extensionTestsPath' || arg.startsWith('--extensionTestsPath=')));
}

/**
 * Remember the editor child `@vscode/test-electron` starts. The package does not return it.
 * `runTests` is the spawn whose arguments include `--extensionTestsPath`. Elsewhere than Windows
 * that spawn is detached, so its pid leads a process group and {@link killProcessTree} can reach
 * the editor and the processes it started. Call `restore` before killing: the kill spawns too.
 */
export function captureEditorProcess(childProcess, platform = process.platform) {
  const original = childProcess.spawn;
  let launched;
  function wrapped(command, args, options) {
    const editor = isEditorLaunch(args);
    const nextOptions = editor && platform !== 'win32' ? { ...options, detached: true } : options;
    const child = original.call(this, command, args, nextOptions);
    if (editor) launched = child;
    return child;
  }
  childProcess.spawn = wrapped;
  return {
    editor() {
      return launched;
    },
    restore() {
      if (childProcess.spawn === wrapped) childProcess.spawn = original;
    },
  };
}

/** The pid of an editor that is still running, or undefined when there is nothing to kill. */
export function editorPid(child) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (child.exitCode != null || child.signalCode != null) return undefined;
  return pid;
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

/**
 * Settle one smoke run.
 * `run` is the deadline-bounded work. `cleanup` runs before a kill or an exit, and a promise it
 * returns is awaited. Success runs `onSuccess` and does not kill or exit.
 * Any other failure is reported and does not kill or exit; the caller sets the failure code.
 * On those paths a cleanup error propagates.
 * A {@link SmokeTimeoutError} is reported, cleaned up, then `kill(child)` is awaited when `kill`
 * is set, and only then `exit` runs with a failure code. A cleanup error on that path is passed to
 * `onCleanupError` when set, otherwise to `console.error`, and the kill and the exit still run.
 * `child` is read at kill time, so it may be a function that returns the editor the run spawned.
 * Exit stays in the same turn as a finished kill. `process.exit` ends the process, and a turn in
 * between would let the hung server or browser keep running.
 */
export async function finishSmoke(child, kill, exit, { run, onSuccess, onFailure, onKillError, onCleanupError, cleanup, failureCode }) {
  let timedOut = false;
  try {
    await run();
    if (onSuccess) {
      const pending = onSuccess();
      if (isThenable(pending)) await pending;
    }
  } catch (error) {
    onFailure(error);
    timedOut = error instanceof SmokeTimeoutError;
  } finally {
    if (cleanup) {
      try {
        const pending = cleanup();
        if (isThenable(pending)) await pending;
      } catch (error) {
        // A timeout still has to kill and exit. Any other cleanup error leaves the function, as before.
        if (!timedOut) throw error;
        if (onCleanupError) onCleanupError(error);
        else console.error(error);
      }
    }
  }
  if (!timedOut) return;
  if (kill) {
    try {
      const pending = kill(child);
      if (isThenable(pending)) await pending;
    } catch (error) {
      if (!onKillError) throw error;
      onKillError(error);
    }
  }
  exit(failureCode() || 1);
}

const defaultFailureCode = () => process.exitCode || 1;
const defaultSetExitCode = (code) => {
  process.exitCode = code;
};

/**
 * Desktop settlement. The evidence directory is removed only after `run` succeeds.
 * On a timeout the editor still running under `child` is killed, that kill is awaited, and only then
 * this process exits. `kill` is {@link killProcessTree} for a real run.
 */
export function finishDesktopSmoke(child, kill, exit, {
  run,
  evidenceDir,
  restore,
  removeEvidence,
  logError = console.error,
  setExitCode = defaultSetExitCode,
  exitCode = defaultFailureCode,
}) {
  return finishSmoke(child, (current) => {
    const editor = typeof current === 'function' ? current() : current;
    const pid = editorPid(editor);
    if (pid === undefined) return undefined;
    return kill(pid);
  }, exit, {
    run,
    onSuccess: removeEvidence,
    onFailure(error) {
      logError(`Desktop extension-host smoke test failed; retained evidence in ${evidenceDir}`, error);
      setExitCode(1);
    },
    onKillError(error) {
      logError('Could not stop the desktop smoke editor', error);
    },
    onCleanupError(error) {
      logError('Could not restore the desktop smoke process capture', error);
    },
    cleanup: restore,
    failureCode: exitCode,
  });
}

/**
 * Browser settlement. test-web keeps the server and the browser when the page never finishes, and it
 * does not return either of them. Cleanup removes a staged copy. On a timeout, `kill(child)` runs
 * when a kill was given, and only then `exit` stops this process, which is what stops the server.
 */
export function finishBrowserSmoke(child, kill, exit, {
  run,
  cleanup,
  logError = console.error,
  setExitCode = defaultSetExitCode,
  exitCode = defaultFailureCode,
}) {
  return finishSmoke(child, kill, exit, {
    run,
    onFailure(error) {
      logError('Browser extension-host smoke test failed', error);
      setExitCode(1);
    },
    onCleanupError(error) {
      logError('Could not remove the staged browser smoke copy', error);
    },
    cleanup,
    failureCode: exitCode,
  });
}
