import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { chooseManifest } from '../../src/lsp/manifest-resolution.js';
import { languageServerStatus, presentStatus } from '../../src/lsp/status.js';
import { LspSupervisor } from '../../src/lsp/supervisor.js';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryDir = join(extensionDir, '../..');
const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8')) as {
  activationEvents: string[];
  capabilities: { untrustedWorkspaces: { supported: string; description: string; restrictedConfigurations: string[] } };
  contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown }> }; commands: { command: string }[] };
  zenwaveLanguageServer: { package: string; version: string };
};

const connected = { kind: 'connected' } as const;
const base = { enabled: true, trusted: true, transport: 'ipc', state: connected } as const;

test('status says why language features are missing, in order of what the user can change', () => {
  assert.deepEqual(languageServerStatus(base), { kind: 'connected' });
  assert.equal(languageServerStatus({ ...base, enabled: false, trusted: false }).kind, 'disabled');
  const untrusted = languageServerStatus({ ...base, trusted: false });
  assert.equal(untrusted.kind, 'untrusted');
  assert.match('reason' in untrusted ? untrusted.reason : '', /trust it to start the language server/);
  assert.deepEqual(languageServerStatus({ ...base, transport: 'none', state: { kind: 'unavailable', reason: 'x' } }),
    { kind: 'no-server', reason: 'no language server transport is available in this host' });
  assert.deepEqual(languageServerStatus({ ...base, absentReason: 'no bundle', state: { kind: 'unavailable', reason: 'x' } }),
    { kind: 'no-server', reason: 'no bundle' });
  assert.deepEqual(languageServerStatus({ ...base, state: { kind: 'failed', reason: 'exited' } }), { kind: 'failed', reason: 'exited' });
  assert.equal(languageServerStatus({ ...base, state: { kind: 'starting' } }).kind, 'starting');
});

test('the indication distinguishes connected, unavailable, failed and a reduced host', () => {
  const none = chooseManifest([]);
  const ok = presentStatus({ kind: 'connected' }, 'desktop', none, '0.1.0-SNAPSHOT');
  assert.equal(ok.text, '$(check) ZenWave');
  assert.match(ok.tooltip, /available \(server 0\.1\.0-SNAPSHOT\)/);
  assert.match(ok.tooltip, /No architecture manifest is configured: set zenwave\.workspace\.manifest/);
  const failed = presentStatus({ kind: 'failed', reason: 'the process exited' }, 'desktop', none, undefined);
  assert.equal(failed.warning, true);
  assert.match(failed.tooltip, /Why: the process exited/);
  const web = presentStatus({ kind: 'no-server', reason: 'no worker' }, 'web', none, undefined);
  assert.equal(web.text, '$(circle-slash) ZenWave (web)');
  assert.match(web.tooltip, /code generation is not available here/);
  assert.match(presentStatus({ kind: 'untrusted', reason: 'r' }, 'desktop', none, undefined).tooltip, /Restricted Mode/);
});

test('JSON-RPC errors keep their code and data, and method-not-found reads as unsupported', async () => {
  const log: string[] = [];
  const logger = { info: (line: string) => log.push(line), warn: (line: string) => log.push(line), error: (line: string) => log.push(line) };
  let failure: unknown;
  const supervisor = new LspSupervisor(() => ({
    start: async () => ({ capabilities: { experimental: { customRequests: ['zenwave/preview'] } } }),
    stop: async () => {},
    sendRequest: async () => { throw failure; },
    onDidExit: () => ({ dispose: () => {} }),
  }), logger);
  await supervisor.start();
  assert.deepEqual(supervisor.advertisedRequests, new Set(['zenwave/preview']));
  failure = Object.assign(new Error('not open'), { code: -32803, data: { kind: 'documentNotFound' } });
  assert.deepEqual(await supervisor.request('zenwave/preview', {}),
    { kind: 'failed', reason: 'not open', code: -32803, data: { kind: 'documentNotFound' } });
  failure = Object.assign(new Error('Unhandled method zenwave/preview'), { code: -32601 });
  assert.deepEqual(await supervisor.request('zenwave/preview', {}), { kind: 'unsupported', method: 'zenwave/preview' });
  assert.ok(log.some((line) => line.includes('advertised zenwave/preview but does not implement it')));
  await supervisor.stop();
  assert.equal(supervisor.advertisedRequests.size, 0);
  assert.equal(supervisor.initializeResult, undefined);
});

test('ESLint enforces which host may import which vscode-languageclient entry', async () => {
  const eslint = new ESLint({ cwd: repositoryDir });
  async function errors(file: string, source: string): Promise<string[]> {
    const [result] = await eslint.lintText(source, { filePath: join(extensionDir, file) });
    return (result?.messages ?? []).filter((message) => message.ruleId === '@typescript-eslint/no-restricted-imports')
      .map((message) => message.message);
  }
  const nodeValue = "import { LanguageClient } from 'vscode-languageclient/node';\nexport const x = LanguageClient;\n";
  const browserValue = "import { LanguageClient } from 'vscode-languageclient/browser';\nexport const x = LanguageClient;\n";
  const bareValue = "import { State } from 'vscode-languageclient';\nexport const x = State;\n";
  const bareType = "import type { State } from 'vscode-languageclient';\nexport type X = State;\n";
  assert.equal((await errors('src/lsp/shared.ts', nodeValue)).length, 1);
  assert.equal((await errors('src/lsp/shared.ts', browserValue)).length, 1);
  assert.equal((await errors('src/lsp/shared.ts', bareValue)).length, 1);
  assert.deepEqual(await errors('src/lsp/shared.ts', bareType), []);
  assert.deepEqual(await errors('src/node/host.ts', nodeValue), []);
  assert.equal((await errors('src/node/host.ts', browserValue)).length, 1);
  assert.deepEqual(await errors('src/browser/host.ts', browserValue), []);
  assert.equal((await errors('src/browser/host.ts', nodeValue)).length, 1);
  assert.equal((await errors('src/browser/host.ts', "import * as fs from 'node:fs';\nexport const x = fs;\n")).length, 1);
});

test('the extension starts only for ZenWave workspaces and documents, or when its views are opened, never at startup', () => {
  assert.deepEqual(manifest.activationEvents.sort(), ['onLanguage:zdl', 'onLanguage:zfl', 'onView:zenwave.architecture', 'onView:zenwave.model',
    'workspaceContains:.zenwave/config.yml']);
});

test('settings, commands and the trust statement match what the language client does', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['zenwave.workspace.manifest']?.scope, 'resource');
  assert.equal(properties['zenwave.lsp.enabled']?.default, true);
  assert.equal(properties['zenwave.lsp.trace.server']?.default, 'off');
  assert.equal(properties['zenwave.lsp.serverPath']?.scope, 'machine-overridable');
  assert.equal(properties['zenwave.credentials.origins']?.scope, 'application', 'a repository must not authorise an origin');
  const commands = manifest.contributes.commands.map((command) => command.command);
  for (const command of ['zenwave.lsp.restart', 'zenwave.lsp.showStatus', 'zenwave.credentials.record', 'zenwave.credentials.clear']) {
    assert.ok(commands.includes(command), command);
  }
  const trust = manifest.capabilities.untrustedWorkspaces;
  assert.equal(trust.supported, 'limited');
  assert.match(trust.description, /no language server/);
  assert.match(trust.description, /no credentials/);
  assert.deepEqual(trust.restrictedConfigurations, ['zenwave.lsp.serverPath', 'zenwave.workspace.manifest']);
});

test('the build fails with instructions when the language server package is not linked', () => {
  const empty = mkdtempSync(join(tmpdir(), 'zenwave-no-lsp-'));
  try {
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: '@zenwave360/lsp-js', version: '0.0.1' }));
    const run = spawnSync(process.execPath, ['esbuild.mjs'], {
      cwd: extensionDir, env: { ...process.env, ZENWAVE_LSP_JS_DIR: empty }, encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    const { package: name, version } = manifest.zenwaveLanguageServer;
    assert.match(run.stderr, new RegExp(`expected ${name.replace('/', '\\/')}@${version.replace(/\./g, '\\.')}`));
    assert.match(run.stderr, /npm install --no-save --workspace packages\/extension/);
    assert.match(run.stderr, /ZENWAVE_LSP_JS_DIR/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
