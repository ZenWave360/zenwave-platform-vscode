import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// The smoke scripts launch VS Code or a browser at load, so the settlement path is run here in a real node
// process with the real deadline, a real hung child as the editor, a real kill and a real process.exit,
// and a timer that would keep the process alive (the hung server) if exit did not end it.
const deadline = pathToFileURL(join(import.meta.dirname, '../../scripts/smoke-deadline.mjs')).href;

const driver = (kind: 'desktop' | 'browser') => `
import { spawn } from 'node:child_process';
import { SmokeTimeoutError, withDeadline, finishDesktopSmoke, finishBrowserSmoke, killProcessTree } from ${JSON.stringify(deadline)};
const say = (line) => process.stdout.write(line + '\\n');
const editor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await new Promise((resolve) => editor.once('spawn', resolve));
say('pid ' + editor.pid);
setInterval(() => {}, 1000); // a server that would keep this process alive
const hung = withDeadline(new Promise(() => {}), 50, 'smoke timed out');
const log = (message) => say('failed ' + message);
const exit = (code) => { say('exit ' + code); process.exit(code); };
if (${JSON.stringify(kind)} === 'desktop') {
  await finishDesktopSmoke(() => editor, async (pid) => { say('kill'); await killProcessTree(pid); say('killed'); }, exit, {
    run: () => hung,
    evidenceDir: 'evidence',
    restore: () => say('cleanup'),
    removeEvidence: () => say('evidence removed'),
    logError: log,
  });
} else {
  await finishBrowserSmoke(undefined, undefined, exit, {
    run: () => hung,
    cleanup: () => { say('cleanup'); throw new Error('cannot remove'); },
    logError: log,
  });
}
say('not reached: the process stayed alive past the timeout path');
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function run(kind: 'desktop' | 'browser') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver(kind)], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '');
  return { result, lines, pid: Number(/^pid (\d+)$/m.exec(result.stdout)?.[1]) };
}

test('a desktop smoke that hits its deadline cleans up, kills the real editor, and exits 1 although a timer would keep it alive', async () => {
  const { result, lines, pid } = run('desktop');
  assert.equal(result.error, undefined, 'the process ended by itself, not by the test timeout');
  assert.equal(result.status, 1, result.stderr);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.deepEqual(lines.slice(1), [lines[1], 'cleanup', 'kill', 'killed', 'exit 1']);
  assert.match(lines[1] ?? '', /^failed /);
  assert.equal(lines.includes('evidence removed'), false, 'evidence is kept after a timeout');
  assert.ok(await gone(pid), 'the editor the run spawned is dead');
});

test('a browser smoke whose cleanup throws after the deadline still exits 1 after reporting both errors', () => {
  const { result, lines, pid } = run('browser');
  assert.equal(result.error, undefined, 'the process ended by itself, not by the test timeout');
  assert.equal(result.status, 1, result.stderr);
  assert.match(lines[1] ?? '', /^failed /);
  assert.equal(lines.at(-1), 'exit 1');
  assert.ok(lines.indexOf('cleanup') < lines.indexOf('exit 1'), 'cleanup runs before the exit');
  assert.equal(lines.includes('not reached: the process stayed alive past the timeout path'), false);
  // finishBrowserSmoke has no kill, so the stand-in editor is not this script's to stop; the test stops it.
  if (alive(pid)) process.kill(pid);
});
