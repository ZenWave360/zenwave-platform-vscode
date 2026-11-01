import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
// @ts-expect-error A build script without type declarations.
import { linkedSiblings, linkSiblings } from '../../scripts/siblings.mjs';

const DSL = '@zenwave360/dsl';
let workspace: string;
let root: string;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function installDslFromRegistry(): void {
  write(join(root, 'node_modules/@zenwave360/dsl/package.json'), JSON.stringify({ name: DSL, version: '1.10.0' }));
}

function buildDslSibling(name = DSL): void {
  const directory = join(workspace, 'dsl-kotlin/build/js/packages/dsl-kotlin');
  write(join(directory, 'package.json'), JSON.stringify({ name, version: '1.11.0-next.0' }));
  write(join(directory, 'kotlin/dsl-kotlin.mjs'), '');
}

function installedVersion(): string {
  return JSON.parse(readFileSync(join(root, 'node_modules/@zenwave360/dsl/package.json'), 'utf8')).version;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zenwave-siblings-'));
  root = join(workspace, 'zenwave-platform-vscode');
  mkdirSync(root);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test('a built sibling replaces the installed package, and linking again changes nothing', () => {
  installDslFromRegistry();
  buildDslSibling();
  const first = linkSiblings(root, {});
  linkSiblings(root, {});
  assert.equal(installedVersion(), '1.11.0-next.0');
  assert.deepEqual(linkedSiblings(root).map((sibling: { package: string }) => sibling.package), [DSL]);
  assert.match(first[0], /linked to \.\.\/dsl-kotlin.*1\.11\.0-next\.0/);
});

test('without a sibling, or with one not built, the registry package stays', () => {
  installDslFromRegistry();
  assert.match(linkSiblings(root, {})[0], /from the registry/);
  write(join(workspace, 'dsl-kotlin/build/js/packages/dsl-kotlin/package.json'), JSON.stringify({ name: DSL, version: '1.11.0-next.0' }));
  assert.match(linkSiblings(root, {})[0], /from the registry/);
  assert.equal(installedVersion(), '1.10.0');
  assert.deepEqual(linkedSiblings(root), []);
});

test('a directory holding another package is not linked', () => {
  installDslFromRegistry();
  buildDslSibling('@zenwave360/other');
  linkSiblings(root, {});
  assert.equal(installedVersion(), '1.10.0');
});

test('opting out leaves the registry package, and removes a link but not what it points at', () => {
  installDslFromRegistry();
  buildDslSibling();
  const optOut = { ZENWAVE_USE_LOCAL_DEPENDENCIES: 'false' };
  assert.match(linkSiblings(root, optOut)[0], /from the registry/);
  assert.equal(installedVersion(), '1.10.0');

  linkSiblings(root, {});
  assert.match(linkSiblings(root, optOut)[0], /npm ci/);
  assert.deepEqual(linkedSiblings(root), []);
  assert.equal(existsSync(join(root, 'node_modules/@zenwave360/dsl')), false);
  assert.ok(lstatSync(join(workspace, 'dsl-kotlin/build/js/packages/dsl-kotlin/package.json')).isFile());
});
