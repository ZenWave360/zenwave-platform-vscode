import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from '@vscode/test-electron';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagedVsix = process.env.ZENWAVE_SMOKE_VSIX;
// Codex may itself be hosted by Electron. Its Node-mode switch must not turn
// the test editor into a Node CLI that interprets the workspace as a script.
delete process.env.ELECTRON_RUN_AS_NODE;
const testRoot = path.join(projectDir, '.vscode-test');
fs.mkdirSync(testRoot, { recursive: true });
const isolated = fs.mkdtempSync(path.join(testRoot, 'sdk-smoke-'));
const workspace = path.join(isolated, 'workspace');
const userData = path.join(isolated, 'user-data');
const extensions = path.join(isolated, 'extensions');
fs.cpSync(path.join(projectDir, 'fixtures'), workspace, { recursive: true });
const shell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : '/bin/bash';
const platform = { win32: 'windows', darwin: 'osx' }[process.platform] || 'linux';
fs.writeFileSync(path.join(workspace, '.sdk-smoke.json'), JSON.stringify({
  cliCommand: `"${process.execPath}" "${path.join(workspace, 'sdk-fixture.mjs')}"`,
  shell,
  unsupportedShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/nu',
  platform,
}));
fs.copyFileSync(path.join(projectDir, 'test/fixtures/sdk-fixture.mjs'), path.join(workspace, 'sdk-fixture.mjs'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({
  'files.autoSave': 'off',
  'terminal.integrated.enablePersistentSessions': false,
  [`terminal.integrated.automationProfile.${platform}`]: { path: shell },
}));

function logContents(directory) {
  if (!fs.existsSync(directory)) return '';
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? logContents(file) : entry.name.endsWith('.log') ? fs.readFileSync(file, 'utf8') : '';
  }).join('\n');
}

try {
  const vscodeExecutablePath = packagedVsix
    ? await downloadAndUnzipVSCode('stable')
    : undefined;
  if (packagedVsix) {
    await runVSCodeCommand(['--install-extension', path.resolve(packagedVsix), '--force',
      '--user-data-dir', userData, '--extensions-dir', extensions], {
      version: 'stable',
    });
  }
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: packagedVsix
      ? path.join(projectDir, 'test/smoke-harness')
      : projectDir,
    extensionTestsPath: path.join(projectDir, '.test-dist/node/index.js'),
    launchArgs: [
      workspace,
      '--user-data-dir', userData,
      '--extensions-dir', extensions,
      ...(packagedVsix ? [] : ['--disable-extensions']),
    ],
  });
  const logs = logContents(path.join(userData, 'logs'));
  if (!logs.includes('ZenWave SDK runs only through a POSIX shell') ||
      !logs.includes('Could not find "definitely-not-a-zenwave-smoke-executable"') ||
      !logs.includes('Searched PATH=')) {
    throw new Error(`Expected unsupported-shell and missing-executable diagnostics in ${userData}/logs`);
  }
  console.log('PASS: refusals report shell guidance and executable/PATH diagnostics');
  for (const [expected, what] of [
    ['language server: ipc (Node child process)', 'the chosen transport at activation'],
    ['Architecture manifest: ', 'which manifest was resolved'],
    ['from the zenwave.workspace.manifest setting', 'the setting route'],
    ['Language server connected: zenwave-lsp', 'that the server started'],
    ['zenwave.lsp.serverPath names', 'why a configured server could not start'],
    ["Sending request 'textDocument/hover", 'the protocol trace with zenwave.lsp.trace.server'],
    ["Sending notification 'workspace/didChangeWatchedFiles'", 'the manifest change notified to the server'],
    ['Credential request for https://github.com.attacker.example/x refused', 'the credential refusal'],
    ['Architecture tree: ', 'what the architecture tree shows'],
    ['Architecture tree is empty: no architecture manifest was resolved', 'why the architecture tree is empty without a manifest'],
    ['Model tree is empty: it needs the ZenWave language server', 'why the model tree is empty without a server'],
  ]) {
    if (!logs.includes(expected)) throw new Error(`The ZenWave output channel does not record ${what} ("${expected}")`);
  }
  console.log('PASS: output channel records transport, manifest route, server lifecycle, protocol trace and refusals');
  // Check the absolute deletion target is a child of this runner's test root.
  const relative = path.relative(path.resolve(testRoot), path.resolve(isolated));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path');
  fs.rmSync(isolated, { recursive: true, force: true });
} catch (error) {
  console.error(`Desktop extension-host smoke test failed; retained evidence in ${isolated}`, error);
  process.exitCode = 1;
}
