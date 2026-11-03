import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error A build script without type declarations.
import { SmokeTimeoutError, finishBrowserSmoke, finishDesktopSmoke, killProcessTree } from '../../scripts/smoke-deadline.mjs';

// The smoke scripts launch VS Code or a browser at load, so these tests call the settlement helpers
// with a fake run, a fake kill and a fake exit. Nothing here starts an editor or a browser.

type Editor = { pid: number; exitCode: number | null; signalCode: string | null };

const script = (name: string) => readFileSync(join(import.meta.dirname, '../../scripts', name), 'utf8').replace(/\r\n/g, '\n');

test('the smoke scripts settle through finishDesktopSmoke and finishBrowserSmoke', () => {
  const desktop = script('run-desktop-smoke.mjs');
  const browser = script('run-browser-smoke.mjs');
  assert.match(desktop, /finishDesktopSmoke\(\(\) => editorCapture\.editor\(\), killProcessTree, \(code\) => process\.exit\(code\)/);
  assert.match(browser, /finishBrowserSmoke\(undefined, undefined, \(code\) => process\.exit\(code\)/);
  assert.equal(browser.includes('killProcessTree'), false);
});

test('a desktop smoke that times out keeps its evidence, kills the editor tree, and exits 1 only after that kill', async () => {
  const events: unknown[] = [];
  const error = new SmokeTimeoutError('timed out');
  let editor: Editor | undefined;
  let finishTaskkill: (code: number) => void = () => {};
  const finished = finishDesktopSmoke(() => editor, (pid: number) => killProcessTree(pid, 'win32', {
    spawn(command: string, args: readonly string[]) {
      events.push(['spawn', command, args]);
      const child = new EventEmitter();
      finishTaskkill = (code) => child.emit('exit', code);
      return child;
    },
    kill() {
      throw new Error('a Windows kill must not signal a process group');
    },
  }), (code: number) => {
    events.push(['exit', code]);
  }, {
    run() {
      editor = { pid: 42, exitCode: null, signalCode: null };
      throw error;
    },
    evidenceDir: 'sdk-smoke-dir',
    restore() { events.push('restore'); },
    removeEvidence() { events.push('remove'); },
    logError(...args: unknown[]) { events.push(['log', ...args]); },
    setExitCode(code: number) { events.push(['code', code]); },
    exitCode: () => 1,
  });
  assert.deepEqual(events, [
    ['log', 'Desktop extension-host smoke test failed; retained evidence in sdk-smoke-dir', error],
    ['code', 1],
    'restore',
    ['spawn', 'taskkill', ['/PID', '42', '/T', '/F']],
  ]);
  finishTaskkill(0);
  await finished;
  assert.deepEqual(events.at(-1), ['exit', 1]);
  assert.equal(events.includes('remove'), false);
});

test('a desktop smoke that times out kills a unix editor by its process group and still exits if the kill fails', async () => {
  const signals: unknown[][] = [];
  const events: string[] = [];
  const live: Editor = { pid: 42, exitCode: null, signalCode: null };
  const finished = finishDesktopSmoke(() => live, (pid: number) => killProcessTree(pid, 'linux', {
    spawn() {
      throw new Error('a process-group kill does not spawn taskkill');
    },
    kill(...args: unknown[]) {
      signals.push(args);
    },
  }), (code: number) => {
    events.push(`exit ${code}`);
  }, {
    run() { throw new SmokeTimeoutError('timed out'); },
    evidenceDir: 'sdk-smoke-dir',
    restore() { events.push('restore'); },
    removeEvidence() { events.push('remove'); },
    logError(message: unknown) { events.push(String(message)); },
    setExitCode() { events.push('code'); },
    exitCode: () => 1,
  });
  assert.deepEqual(signals, [[-42, 'SIGKILL']]);
  assert.equal(events.includes('exit 1'), false);
  await finished;
  assert.deepEqual(events, [
    'Desktop extension-host smoke test failed; retained evidence in sdk-smoke-dir',
    'code',
    'restore',
    'exit 1',
  ]);

  const failed: string[] = [];
  let finishTaskkill: (code: number) => void = () => {};
  const failing = finishDesktopSmoke(live, (pid: number) => killProcessTree(pid, 'win32', {
    spawn() {
      const child = new EventEmitter();
      finishTaskkill = (code) => child.emit('exit', code);
      return child;
    },
    kill() {
      return undefined;
    },
  }), (code: number) => {
    failed.push(`exit ${code}`);
  }, {
    run() { throw new SmokeTimeoutError('timed out'); },
    evidenceDir: 'sdk-smoke-dir',
    restore() { failed.push('restore'); },
    removeEvidence() { failed.push('remove'); },
    logError(message: unknown) { failed.push(String(message)); },
    setExitCode() { failed.push('code'); },
    exitCode: () => 0,
  });
  assert.equal(failed.includes('exit 1') || failed.includes('exit 0'), false);
  finishTaskkill(1);
  await failing;
  assert.equal(failed.includes('remove'), false);
  assert.ok(failed.includes('Could not stop the desktop smoke editor'));
  assert.equal(failed.at(-1), 'exit 1');
  assert.ok(failed.indexOf('Could not stop the desktop smoke editor') < failed.indexOf('exit 1'));
});

test('a desktop smoke that times out with no editor still exits 1 and does not kill another process', async () => {
  const gone: Array<Editor | undefined> = [
    undefined,
    { pid: 42, exitCode: 0, signalCode: null },
    { pid: 42, exitCode: null, signalCode: 'SIGTERM' },
  ];
  for (const editor of gone) {
    const events: string[] = [];
    await finishDesktopSmoke(() => editor, () => {
      events.push('kill');
    }, (code: number) => {
      events.push(`exit ${code}`);
    }, {
      run() { throw new SmokeTimeoutError('timed out'); },
      evidenceDir: 'sdk-smoke-dir',
      restore() { events.push('restore'); },
      removeEvidence() { events.push('remove'); },
      logError() { events.push('log'); },
      setExitCode() { events.push('code'); },
      exitCode: () => 1,
    });
    assert.deepEqual(events, ['log', 'code', 'restore', 'exit 1']);
  }
});

test('a desktop smoke that passes removes its evidence, kills nothing, and leaves the exit code at 0', async () => {
  const events: string[] = [];
  let code = 0;
  const live: Editor = { pid: 7, exitCode: null, signalCode: null };
  await finishDesktopSmoke(() => live, () => {
    events.push('kill');
  }, () => {
    events.push('exit');
  }, {
    run() { events.push('run'); },
    evidenceDir: 'sdk-smoke-dir',
    restore() { events.push('restore'); },
    removeEvidence() { events.push('remove'); },
    logError() { events.push('log'); },
    setExitCode(next: number) { code = next; events.push('code'); },
    exitCode: () => code || 1,
  });
  assert.deepEqual(events, ['run', 'remove', 'restore']);
  assert.equal(code, 0);
});

test('a desktop smoke that fails a test keeps its evidence, kills nothing, and finishes non-zero only after cleanup', async () => {
  const events: unknown[] = [];
  const error = new Error('one assertion failed');
  let code = 0;
  let release: () => void = () => {};
  let settled = false;
  const live: Editor = { pid: 7, exitCode: null, signalCode: null };
  const finished = finishDesktopSmoke(() => live, () => {
    events.push('kill');
  }, () => {
    events.push('exit');
  }, {
    run() { throw error; },
    evidenceDir: 'sdk-smoke-dir',
    restore() {
      events.push('restore');
      return new Promise<void>((resolve) => { release = resolve; });
    },
    removeEvidence() { events.push('remove'); },
    logError(...args: unknown[]) { events.push(['log', ...args]); },
    setExitCode(next: number) { code = next; events.push('code'); },
    exitCode: () => code || 1,
  });
  void finished.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(code, 1);
  assert.deepEqual(events, [
    ['log', 'Desktop extension-host smoke test failed; retained evidence in sdk-smoke-dir', error],
    'code',
    'restore',
  ]);
  release();
  await finished;
  assert.equal(settled, true);
  assert.equal(events.includes('kill'), false);
  assert.equal(events.includes('remove'), false);
  assert.equal(events.includes('exit'), false);
});

test('a browser smoke that times out reports the failure, finishes removing the staged copy, and only then exits 1', async () => {
  const events: unknown[] = [];
  const error = new SmokeTimeoutError('timed out');
  let release: () => void = () => {};
  const finished = finishBrowserSmoke(undefined, undefined, (code: number) => {
    events.push(['exit', code]);
  }, {
    run() { throw error; },
    cleanup() {
      events.push('cleanup');
      return new Promise<void>((resolve) => { release = resolve; });
    },
    logError(...args: unknown[]) { events.push(['log', ...args]); },
    setExitCode(code: number) { events.push(['code', code]); },
    exitCode: () => 1,
  });
  assert.deepEqual(events, [
    ['log', 'Browser extension-host smoke test failed', error],
    ['code', 1],
    'cleanup',
  ]);
  release();
  await finished;
  assert.deepEqual(events.at(-1), ['exit', 1]);
});

test('a browser smoke that times out closes a server or browser it was given, and waits for that before exiting', async () => {
  const events: string[] = [];
  const server = { kind: 'server' };
  let release: () => void = () => {};
  const finished = finishBrowserSmoke(server, (host: unknown) => {
    assert.equal(host, server);
    events.push('kill');
    return new Promise<void>((resolve) => { release = resolve; });
  }, (code: number) => {
    events.push(`exit ${code}`);
  }, {
    run() { throw new SmokeTimeoutError('timed out'); },
    cleanup() { events.push('cleanup'); },
    logError() { events.push('log'); },
    setExitCode() { events.push('code'); },
    exitCode: () => 1,
  });
  assert.deepEqual(events, ['log', 'code', 'cleanup', 'kill']);
  release();
  await finished;
  assert.deepEqual(events, ['log', 'code', 'cleanup', 'kill', 'exit 1']);
});

test('a browser smoke that passes cleans up, kills nothing, and leaves the exit code at 0', async () => {
  const events: string[] = [];
  let code = 0;
  await finishBrowserSmoke({ kind: 'browser' }, () => {
    events.push('kill');
  }, () => {
    events.push('exit');
  }, {
    run() { events.push('run'); },
    cleanup() { events.push('cleanup'); },
    logError() { events.push('log'); },
    setExitCode(next: number) { code = next; events.push('code'); },
    exitCode: () => code || 1,
  });
  assert.deepEqual(events, ['run', 'cleanup']);
  assert.equal(code, 0);
});

test('a browser smoke that fails a test exits non-zero only after cleanup and does not stop the host early', async () => {
  const events: unknown[] = [];
  const error = new Error('Test failed');
  let code = 0;
  let release: () => void = () => {};
  let settled = false;
  const finished = finishBrowserSmoke({ kind: 'browser' }, () => {
    events.push('kill');
  }, () => {
    events.push('exit');
  }, {
    run() { throw error; },
    cleanup() {
      events.push('cleanup');
      return new Promise<void>((resolve) => { release = resolve; });
    },
    logError(...args: unknown[]) { events.push(['log', ...args]); },
    setExitCode(next: number) { code = next; events.push('code'); },
    exitCode: () => code || 1,
  });
  void finished.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(code, 1);
  assert.deepEqual(events, [
    ['log', 'Browser extension-host smoke test failed', error],
    'code',
    'cleanup',
  ]);
  release();
  await finished;
  assert.equal(settled, true);
  assert.equal(events.includes('kill'), false);
  assert.equal(events.includes('exit'), false);
});

test('a timeout whose cleanup throws reports the error, awaits the kill, and then exits 1', async () => {
  const events: unknown[] = [];
  const timeout = new SmokeTimeoutError('timed out');
  const cleanupError = new Error('restore failed');
  const editor: Editor = { pid: 42, exitCode: null, signalCode: null };
  let releaseKill: () => void = () => {};
  let settled = false;
  const finished = finishDesktopSmoke(() => editor, (pid: number) => {
    events.push(['kill', pid]);
    return new Promise<void>((resolve) => { releaseKill = resolve; });
  }, (code: number) => {
    events.push(['exit', code]);
  }, {
    run() { throw timeout; },
    evidenceDir: 'sdk-smoke-dir',
    restore() { throw cleanupError; },
    removeEvidence() { events.push('remove'); },
    logError(...args: unknown[]) { events.push(['log', ...args]); },
    setExitCode(code: number) { events.push(['code', code]); },
    exitCode: () => 1,
  });
  void finished.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(settled, false);
  assert.deepEqual(events, [
    ['log', 'Desktop extension-host smoke test failed; retained evidence in sdk-smoke-dir', timeout],
    ['code', 1],
    ['log', 'Could not restore the desktop smoke process capture', cleanupError],
    ['kill', 42],
  ]);
  releaseKill();
  await finished;
  assert.equal(settled, true);
  const killAt = events.findIndex((event) => Array.isArray(event) && event[0] === 'kill');
  const exitAt = events.findIndex((event) => Array.isArray(event) && event[0] === 'exit');
  assert.ok(killAt !== -1 && killAt < exitAt);
  assert.deepEqual(events[exitAt], ['exit', 1]);
  assert.equal(events.includes('remove'), false);
});
