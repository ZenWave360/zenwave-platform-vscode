import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogue, SHIPPED_CATALOGUE } from '../../src/sdk/catalogue.js';

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

test('catalogue parsing uses the simple class name and retains reported option metadata', () => {
  const catalogue = parseCatalogue(RAW);
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
  assert.equal(parseCatalogue(RAW)?.plugins[0]?.documentation, 'https://example.test/plugin');
  const withoutLink = parseCatalogue({
    plugins: [{ configClassName: 'com.example.PrivatePlugin', options: {} }],
  });
  assert.equal(withoutLink?.plugins[0]?.documentation, undefined);
});

test('the shipped catalogue names the SDK build it describes', () => {
  assert.ok(SHIPPED_CATALOGUE.plugins.length > 0);
  assert.match(SHIPPED_CATALOGUE.source, /^ZenWave SDK \S+/);
  assert.notEqual(SHIPPED_CATALOGUE.version, 'unknown');
});
