import assert from 'node:assert/strict';
import test from 'node:test';
import { isPluginNamePosition, ModelCache, parseModel, toSourceRange } from '../../src/sdk/model.js';

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
  const tupleLike = { 0: 10, 1: 20, 2: 3, 3: 4, 4: 5, 5: 6, length: 6 };
  assert.deepEqual(toSourceRange(tupleLike), {
    start: { line: 2, character: 4 },
    end: { line: 4, character: 7 },
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

test('the upstream parser identifies plugin-name completion positions', () => {
  const text = 'config { plugins { \n  \n} }';
  assert.equal(isPluginNamePosition(text, text.indexOf('\n  \n') + 3), true);
  assert.equal(isPluginNamePosition('entity Order { id UUID }', 0), false);
});
