// A local smoke run has no CI timeout-minutes. test-web never settles when the page answers 500, and
// test-electron never settles when the editor does not exit. The deadline rejects; the caller still runs its
// cleanup and then exits, because the server, browser or editor can keep the process alive after the rejection.
// test-electron kills the editor only when this process receives SIGINT, so a timeout has to kill that tree first.

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
