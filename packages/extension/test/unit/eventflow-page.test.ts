import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
// @ts-expect-error A build script without type declarations.
import { chooseEventFlowPage } from '../../scripts/eventflow-page.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zenwave-eventflow-page-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function page(name: string, complete = true): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'index.html'), '<html></html>');
  if (complete) writeFileSync(join(root, name, 'protocol.json'), '{}');
}

test('the page with a view selector is shipped when the package has it', () => {
  page('webview');
  page('webview-toolbar');
  assert.equal(chooseEventFlowPage(root).name, 'webview-toolbar');
  assert.equal(chooseEventFlowPage(root).page, join(root, 'webview-toolbar'));
});

test('a package with only webview/ (the pinned 0.1.0) ships that page', () => {
  page('webview');
  assert.equal(chooseEventFlowPage(root).name, 'webview');
});

test('an incomplete webview-toolbar/ falls back, and a package with no built page says so', () => {
  page('webview');
  page('webview-toolbar', false);
  assert.equal(chooseEventFlowPage(root).name, 'webview');
  rmSync(join(root, 'webview'), { recursive: true });
  assert.equal(chooseEventFlowPage(root), undefined);
});
