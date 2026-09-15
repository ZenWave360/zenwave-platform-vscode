import assert from 'node:assert/strict';
import test from 'node:test';
import { loginShellArguments, resolveLoginShell } from '../../src/sdk/shell.js';

test('an explicit login shell wins over the preferred terminal shell', () => {
  assert.equal(resolveLoginShell('  /opt/custom/bash  ', '/bin/zsh'), '/opt/custom/bash');
});

test('an empty login shell falls back to the preferred terminal shell', () => {
  assert.equal(
    resolveLoginShell('', 'C:\\Program Files\\Git\\bin\\bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  );
  assert.equal(resolveLoginShell(undefined, '  /bin/zsh  '), '/bin/zsh');
});

test('login shell arguments follow the detected shell family', () => {
  assert.deepEqual(loginShellArguments('C:\\Program Files\\Git\\bin\\bash.exe'), ['-l', '-c']);
  assert.deepEqual(loginShellArguments('/bin/zsh'), ['-l', '-c']);
  assert.deepEqual(loginShellArguments('pwsh.exe'), ['-Login', '-Command']);
  assert.deepEqual(loginShellArguments('powershell.exe'), ['-NoLogo', '-Command']);
  assert.deepEqual(loginShellArguments('cmd.exe'), ['/s', '/c']);
  assert.deepEqual(loginShellArguments('nu'), ['--login', '--commands']);
  assert.deepEqual(loginShellArguments('wsl.exe'), ['--exec', 'sh', '-lc']);
});

test('an unknown shell uses the conventional login-command arguments', () => {
  assert.deepEqual(loginShellArguments('/opt/custom-shell'), ['-l', '-c']);
});
