import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseManifest } from '../../src/lsp/manifest-resolution.js';
import { initializationOptions } from '../../src/lsp/manifest-resolution.js';
import { loadPluginCatalogue, shippedCatalogueSource } from '../../src/lsp/plugin-catalogue.js';

const here = dirname(fileURLToPath(import.meta.url));
const shippedFile = JSON.parse(readFileSync(join(here, '../../resources/sdk-plugin-catalogue.json'), 'utf8')) as { plugins: unknown[] };

function logger() {
  const lines: string[] = [];
  return { lines, info: (line: string) => { lines.push(`info: ${line}`); }, warn: (line: string) => { lines.push(`warn: ${line}`); } };
}

test('the shipped catalogue is what the extension sends, as the JSON object the server reads (MP-R16)', async () => {
  const log = logger();
  const catalogue = await loadPluginCatalogue(shippedCatalogueSource, log);
  assert.deepEqual(catalogue, shippedFile);
  assert.ok(shippedFile.plugins.length > 0);
  assert.match(log.lines.join('\n'), /^info: Plugin catalogue: sending the extension's copy/);
});

test('the catalogue goes in the initialization options at the top level, beside zenwave', async () => {
  const catalogue = await loadPluginCatalogue(shippedCatalogueSource, logger());
  const options = initializationOptions(chooseManifest([]), true, catalogue);
  assert.deepEqual(Object.keys(options).sort(), ['pluginCatalogue', 'zenwave']);
  assert.equal(options.pluginCatalogue, catalogue);
  assert.deepEqual(options.zenwave, { clientCapabilities: { credentialRequest: true } });
});

test('a catalogue that cannot be read is logged and left out, and the server starts with its own copy', async () => {
  const unreadable: [string, () => unknown][] = [
    ['throws', () => { throw new Error('ENOENT: no such file'); }],
    ['rejects', () => Promise.reject(new Error('unreadable'))],
    ['is not an object', () => 'not json'],
    ['is an array', () => []],
    ['has no plugins list', () => ({ source: 'x', version: '1' })],
  ];
  for (const [name, source] of unreadable) {
    const log = logger();
    const catalogue = await loadPluginCatalogue(source, log);
    assert.equal(catalogue, undefined, name);
    assert.equal(log.lines.length, 1, name);
    assert.match(log.lines[0]!, /^warn: Plugin catalogue: .*the language server uses its own$/, name);
    const options = initializationOptions(chooseManifest([]), false, catalogue);
    assert.deepEqual(options, { zenwave: { clientCapabilities: { credentialRequest: false } } }, `${name}: the option is left out`);
    assert.ok(!('pluginCatalogue' in options), name);
  }
});
