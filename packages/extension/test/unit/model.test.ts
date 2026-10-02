import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZdl } from '@zenwave360/dsl';
import { findRunnablePlugin, isPluginNamePosition, ModelCache, parseModel, toSourceRange } from '../../src/sdk/model.js';

const MODEL = `
config {
  basePackage "io.example"
  plugins {
    DefaultPlugin { own default }
    ExplicitPlugin (inherit true) { own explicit }
    disabled DisabledPlugin (inherit false) { own disabled }
  }
}`;

test('ANTLR locations become zero-based, end-exclusive editor ranges', () => {
  const raw = parseZdl(MODEL) as { locations: Record<string, Int32Array> };
  const declaration = raw.locations['pluginsList.0']!;
  const name = raw.locations['pluginsList.0.name']!;
  const line = MODEL.split('\n')[4]!;
  assert.equal(declaration[5], line.lastIndexOf('}'), 'declaration end column is inclusive');
  assert.equal(name[5], line.indexOf('DefaultPlugin') + 'DefaultPlugin'.length,
    'name end column is exclusive');
  assert.deepEqual(toSourceRange(declaration, MODEL), {
    start: { line: 4, character: 4 },
    end: { line: 4, character: line.lastIndexOf('}') + 1 },
  });
  assert.deepEqual(toSourceRange(name, MODEL), {
    start: { line: 4, character: 4 },
    end: { line: 4, character: 17 },
  });
  assert.deepEqual(parseModel(MODEL)?.locations['pluginsList.0.name'],
    toSourceRange(name, MODEL));
});

test('parseModel exposes locally built DSL plugin config option and value spans', () => {
  const text = 'config {\n  plugins {\n    MyPlugin {\n      displayName "Orders API"\n    }\n  }\n}';
  const model = parseModel(text);
  assert.deepEqual(model?.locations['pluginsList.0.config.displayName'], {
    start: { line: 3, character: 6 }, end: { line: 3, character: 30 },
  });
  assert.deepEqual(model?.locations['pluginsList.0.config.displayName.value'], {
    start: { line: 3, character: 18 }, end: { line: 3, character: 30 },
  });
});

test('parseModel exposes config-level CLI options without corrupting following config', () => {
  const text = `config {
    title "shared"
    --force
    --profile="local build"
    useJSpecify true
    plugins { MyPlugin {} }
  }`;
  const model = parseModel(text);
  assert.ok(model);
  assert.deepEqual(model.cliOptions, [
    { name: 'force' },
    { name: 'profile', value: '"local build"' },
  ]);
  assert.equal(model.config.title, 'shared');
  assert.equal(model.config.useJSpecify, true);
  assert.deepEqual(model.locations['cliOptions.force'], {
    start: { line: 2, character: 4 }, end: { line: 2, character: 11 },
  });
  assert.deepEqual(model.locations['config.useJSpecify'], {
    start: { line: 4, character: 4 }, end: { line: 4, character: 20 },
  });
});

test('plugin discovery reads all declarations, disabled state, and inherit strings', () => {
  const model = parseModel(MODEL);
  assert.ok(model);
  assert.deepEqual(
    model.plugins.map(({ name, disabled, inherit }) => ({ name, disabled, inherit })),
    [
      { name: 'DefaultPlugin', disabled: false, inherit: true },
      { name: 'ExplicitPlugin', disabled: false, inherit: true },
      { name: 'DisabledPlugin', disabled: true, inherit: false },
    ],
  );
});

test('plugin discovery keeps every declaration when several share a type name', () => {
  const text = `
config {
  plugins {
    SamePlugin { targetFolder "one" }
    SamePlugin { targetFolder "two" }
    OtherPlugin { targetFolder "three" }
  }
}`;
  const model = parseModel(text);
  assert.ok(model);
  assert.deepEqual(
    model.plugins.map(({ name, config }) => ({ name, targetFolder: config.targetFolder })),
    [
      { name: 'SamePlugin', targetFolder: 'one' },
      { name: 'SamePlugin', targetFolder: 'two' },
      { name: 'OtherPlugin', targetFolder: 'three' },
    ],
  );
  assert.notEqual(model.plugins[0]?.offsets[0], model.plugins[1]?.offsets[0]);
  const first = text.indexOf('SamePlugin { targetFolder "one" }');
  const second = text.indexOf('SamePlugin { targetFolder "two" }');
  assert.equal(model.plugins[0]?.offsets[0], first);
  assert.equal(model.plugins[1]?.offsets[0], second);
  assert.equal(findRunnablePlugin(model, 'SamePlugin', second)?.config.targetFolder, 'two');
  assert.equal(findRunnablePlugin(model, 'SamePlugin', first)?.config.targetFolder, 'one');
});

test('an unfinished plugin recovered by ANTLR is not exposed as runnable', () => {
  const model = parseModel('config { plugins { BrokenPlugin { targetFolder "."');
  assert.ok(model);
  assert.deepEqual(model.plugins, []);
});

test('a model without a config block has no plugins', () => {
  assert.deepEqual(parseModel('entity Order { id UUID }')?.plugins, []);
});

test('model parses are cached by document URI and version', () => {
  let calls = 0;
  const cache = new ModelCache(() => {
    calls += 1;
    return parseModel(MODEL);
  });
  cache.get('file:///model.zdl', 1, MODEL);
  cache.get('file:///model.zdl', 1, MODEL);
  cache.get('file:///model.zdl', 2, MODEL);
  assert.equal(calls, 2);
});

test('model cache retains multiple documents and evicts the least recently used URI', () => {
  const calls: string[] = [];
  const cache = new ModelCache((text) => { calls.push(text); return undefined; }, 2);
  cache.get('a', 1, 'a');
  cache.get('b', 1, 'b');
  cache.get('a', 1, 'a');
  cache.get('c', 1, 'c');
  cache.get('a', 1, 'a');
  cache.get('b', 1, 'b');
  cache.get('b', 2, 'b2');
  cache.get('b', 2, 'b2');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b', 'b2']);
});

test('the upstream parser identifies plugin-name completion positions', () => {
  const text = 'config { plugins { \n  \n} }';
  assert.equal(isPluginNamePosition(text, text.indexOf('\n  \n') + 3), true);
  assert.equal(isPluginNamePosition('entity Order { id UUID }', 0), false);
});
