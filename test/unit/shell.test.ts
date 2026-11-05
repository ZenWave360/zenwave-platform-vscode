import assert from 'node:assert/strict';
import test from 'node:test';
import { loginShellArguments, resolveLoginShell, shellFamily } from '../../src/sdk/shell.js';

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

test('POSIX shells and PowerShell are the supported quoting families', () => {
  assert.equal(shellFamily('C:\\Program Files\\Git\\bin\\bash.exe'), 'posix');
  assert.equal(shellFamily('/bin/zsh'), 'posix');
  assert.equal(shellFamily('/bin/sh'), 'posix');
  assert.equal(shellFamily('pwsh.exe'), 'powershell');
  assert.equal(shellFamily('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
});

test('cmd and shells with other quoting rules are not supported', () => {
  assert.equal(shellFamily('C:\\Windows\\System32\\cmd.exe'), undefined);
  assert.equal(shellFamily('nu'), undefined);
  assert.equal(shellFamily('wsl.exe'), undefined);
  assert.equal(shellFamily('/opt/custom-shell'), undefined);
});

test('login shell arguments follow the shell', () => {
  assert.deepEqual(loginShellArguments('C:\\Program Files\\Git\\bin\\bash.exe'), ['-l', '-c']);
  assert.deepEqual(loginShellArguments('/bin/zsh'), ['-l', '-c']);
  assert.deepEqual(loginShellArguments('pwsh.exe'), ['-Login', '-Command']);
  assert.deepEqual(loginShellArguments('powershell.exe'), ['-NoLogo', '-Command']);
  assert.equal(loginShellArguments('cmd.exe'), undefined);
});
