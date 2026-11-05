import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
// @ts-expect-error A build script without type declarations.
import { DEFAULT_SMOKE_TIMEOUT_MS, SmokeTimeoutError, captureEditorProcess, editorPid, killProcessTree, smokeTimeoutMs, withDeadline } from '../../scripts/smoke-deadline.mjs';

test('the smoke deadline is five minutes unless ZENWAVE_SMOKE_TIMEOUT_MS sets it', () => {
  assert.equal(DEFAULT_SMOKE_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(smokeTimeoutMs({}), DEFAULT_SMOKE_TIMEOUT_MS);
  assert.equal(smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '' }), DEFAULT_SMOKE_TIMEOUT_MS);
  assert.equal(smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '1500' }), 1500);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '0' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: 'nope' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
  assert.throws(() => smokeTimeoutMs({ ZENWAVE_SMOKE_TIMEOUT_MS: '2147483648' }), /ZENWAVE_SMOKE_TIMEOUT_MS/);
});

test('a smoke run that finishes does not wait out the deadline', async () => {
  const started = Date.now();
  assert.equal(await withDeadline(Promise.resolve('done'), 30_000, 'should not time out'), 'done');
  assert.ok(Date.now() - started < 1000);
});

test('a smoke run that does not finish rejects, and a late failure is not unhandled', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    let failLate: (error: Error) => void = () => {};
    const hanging = new Promise<never>((_resolve, reject) => {
      failLate = reject;
    });
    await assert.rejects(withDeadline(hanging, 20, 'timed out'), (error: unknown) => {
      assert.ok(error instanceof SmokeTimeoutError);
      assert.match(error.message, /timed out/);
      return true;
    });
    failLate(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a timed-out desktop smoke kills the editor tree with taskkill on Windows and a process-group kill elsewhere', async () => {
  const windows: { command: string; args: readonly string[] }[] = [];
  let finish: (code: number) => void = () => {};
  const pending = killProcessTree(4242, 'win32', {
    spawn(command: string, args: readonly string[]) {
      windows.push({ command, args });
      const child = new EventEmitter();
      finish = (code) => child.emit('exit', code);
      return child;
    },
    kill() {
      throw new Error('a Windows kill must not signal a process group');
    },
  });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'taskkill has not exited yet');
  assert.deepEqual(windows, [{ command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
  finish(0);
  await pending;

  const signals: unknown[][] = [];
  await killProcessTree(7, 'linux', {
    spawn() {
      throw new Error('a process-group kill does not spawn taskkill');
    },
    kill(...args: unknown[]) {
      signals.push(args);
    },
  });
  assert.deepEqual(signals, [[-7, 'SIGKILL']]);
  await assert.rejects(killProcessTree(7, 'win32', {
    spawn() {
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 1));
      return child;
    },
    kill() {
      return undefined;
    },
  }), /taskkill \/PID 7 \/T \/F exited 1/);
  for (const pid of [0, -3, 1.5, Number.NaN]) {
    await assert.rejects(killProcessTree(pid, 'linux', { spawn() { return new EventEmitter(); }, kill() { return undefined; } }), /positive integer/);
  }
});

test('the editor child is the spawn that carries extensionTestsPath, and only a unix spawn leads a process group', () => {
  function install(platform: string) {
    const calls: { command: string; args: readonly string[] | undefined; options: { detached?: boolean; shell?: boolean } | undefined }[] = [];
    const spawn = (command: string, args?: readonly string[], options?: { detached?: boolean; shell?: boolean }) => {
      calls.push({ command, args, options });
      return { pid: calls.length, exitCode: null, signalCode: null };
    };
    const childProcess = { spawn };
    const captured = captureEditorProcess(childProcess, platform);
    return { calls, spawn, childProcess, captured };
  }

  const linux = install('linux');
  linux.childProcess.spawn('unzip', ['archive.zip'], { shell: false });
  linux.childProcess.spawn('/usr/share/code/code', ['--extensionTestsPath=/tmp/index.js', '--no-sandbox'], { shell: false });
  const editor = linux.childProcess.spawn('/usr/share/code/bin/code', ['--extensionTestsPath', '/tmp/index.js'], { shell: false });
  assert.equal(linux.captured.editor(), editor, 'the latest editor launch is the one a timeout kills');
  assert.equal(linux.calls[0]?.options?.detached, undefined);
  assert.deepEqual(linux.calls[1]?.options, { shell: false, detached: true });
  assert.equal(linux.calls[2]?.options?.detached, true);
  assert.equal(editorPid(linux.captured.editor()), 3);
  assert.equal(editorPid({ pid: 2, exitCode: 0, signalCode: null }), undefined);
  assert.equal(editorPid({ pid: 2, exitCode: null, signalCode: 'SIGTERM' }), undefined);
  assert.equal(editorPid(undefined), undefined);
  linux.captured.restore();
  linux.captured.restore();
  assert.equal(linux.childProcess.spawn, linux.spawn);

  const windows = install('win32');
  windows.childProcess.spawn('Code.exe', ['--extensionTestsPath=C:\\tests\\index.js'], { shell: true });
  assert.deepEqual(windows.calls[0]?.options, { shell: true });
  assert.equal(editorPid(windows.captured.editor()), 1);
  windows.captured.restore();
});

test('wrapping child_process.spawn is visible to a later require, which is how test-electron spawns the editor', () => {
  const childProcess = createRequire(import.meta.url)('node:child_process') as { spawn: (...args: unknown[]) => unknown };
  const original = childProcess.spawn;
  const captured = captureEditorProcess(childProcess, 'linux');
  try {
    assert.notEqual(childProcess.spawn, original);
    assert.equal(createRequire(import.meta.url)('node:child_process').spawn, childProcess.spawn);
  } finally {
    captured.restore();
    assert.equal(childProcess.spawn, original);
  }
});
