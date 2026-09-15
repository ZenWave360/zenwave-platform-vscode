import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogue, PluginCatalogue } from '../../src/sdk/catalogue.js';
import type { SdkProcessService, SdkSettings } from '../../src/sdk/host.js';

const RAW = {
  version: '9.8.7',
  plugins: [
    {
      configClassName: 'com.example.CustomPlugin',
      plugin: { summary: 'A custom plugin' },
      documentation: 'https://example.test/plugin',
      options: {
        mode: {
          description: 'Generation mode',
          type: 'Mode',
          defaultValue: 'safe',
          values: ['safe', 'fast'],
          docLink: 'https://example.test/plugin#mode',
        },
      },
      futureField: 'ignored',
    },
  ],
};

const SETTINGS: SdkSettings = {
  cliCommand: 'jbang zw',
  extraArgs: [],
  invocation: { environment: 'inherited', loginShell: '' },
};

const logger = {
  messages: [] as string[],
  info(message: string): void {
    this.messages.push(message);
  },
  warn(message: string): void {
    this.messages.push(message);
  },
};

test('catalogue parsing uses the simple class name and retains reported option metadata', () => {
  const catalogue = parseCatalogue(RAW, 'installed');
  assert.ok(catalogue);
  assert.equal(catalogue.plugins[0]?.name, 'CustomPlugin');
  assert.deepEqual(catalogue.plugins[0]?.options.mode, {
    name: 'mode',
    description: 'Generation mode',
    type: 'Mode',
    defaultValue: 'safe',
    values: ['safe', 'fast'],
    documentation: 'https://example.test/plugin#mode',
  });
});

test('documentation is used only when the catalogue reports it', () => {
  const documented = parseCatalogue(RAW, 'installed');
  assert.equal(documented?.plugins[0]?.documentation, 'https://example.test/plugin');

  const withoutLink = parseCatalogue(
    { plugins: [{ configClassName: 'com.example.PrivatePlugin', options: {} }] },
    'installed',
  );
  assert.equal(withoutLink?.plugins[0]?.documentation, undefined);
});

test('the first request uses shipped knowledge without waiting and later requests replace it', async () => {
  let calls = 0;
  const processService: SdkProcessService = {
    async catalogue() {
      calls += 1;
      return { stdout: JSON.stringify(RAW), stderr: '', exitCode: 0 };
    },
    async probe() {
      return { found: true, diagnosis: '' };
    },
  };
  const catalogues = new PluginCatalogue(processService, logger);
  const first = catalogues.get('workspace', '/work', SETTINGS, true);
  assert.equal(first?.origin, 'shipped');
  assert.ok((first?.plugins.length ?? 0) > 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const loaded = catalogues.get('workspace', '/work', SETTINGS, true);
  assert.equal(calls, 1);
  assert.equal(loaded?.origin, 'installed');
  assert.deepEqual(loaded?.plugins.map((plugin) => plugin.name), ['CustomPlugin']);
});

test('a failed SDK query falls back to shipped knowledge and logs once', async () => {
  let calls = 0;
  const processService: SdkProcessService = {
    async catalogue() {
      calls += 1;
      return { stdout: '', stderr: 'not found', exitCode: 127 };
    },
    async probe() {
      return { found: false, diagnosis: 'not found' };
    },
  };
  const isolatedLogger = {
    messages: [] as string[],
    info(message: string): void {
      this.messages.push(message);
    },
    warn(message: string): void {
      this.messages.push(message);
    },
  };
  const catalogues = new PluginCatalogue(processService, isolatedLogger);
  assert.equal(catalogues.get('workspace', '/work', SETTINGS, true)?.origin, 'shipped');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(catalogues.get('workspace', '/work', SETTINGS, true)?.origin, 'shipped');
  assert.equal(catalogues.get('workspace', '/work', SETTINGS, true)?.origin, 'shipped');
  assert.equal(calls, 1);
  assert.equal(isolatedLogger.messages.length, 1);
  assert.match(isolatedLogger.messages[0] ?? '', /jbang zw -h json/);
});

test('hosts that cannot spawn processes use the marked shipped catalogue immediately', () => {
  const catalogues = new PluginCatalogue(undefined, logger);
  const catalogue = catalogues.get('web', undefined, SETTINGS, false);
  assert.equal(catalogue?.origin, 'shipped');
  assert.match(catalogue?.source ?? '', /ZenWave SDK/);
});
