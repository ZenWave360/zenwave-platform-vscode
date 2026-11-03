import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
// @ts-expect-error A build script without type declarations.
import { linkedSiblings, linkSiblings } from '../../scripts/siblings.mjs';
// @ts-expect-error A build script without type declarations.
import { SIBLING_BUILDS, siblingBuildCommand } from '../../scripts/build-siblings.mjs';

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

test('each sibling build uses an absolute Gradle wrapper, and vistas keeps pnpm', () => {
  const expected = [
    {
      directory: 'dsl-kotlin',
      args: [':dsl-kotlin:jsProductionExecutableCompileSync', ':dsl-kotlin:jsPackageJson', '--console=plain'],
    },
    {
      directory: 'zenwave-lsp',
      args: [':lsp-js:lspJsNpmPack', '--console=plain'],
    },
    {
      directory: 'zenwave-architectural-vistas',
      args: ['--filter', '@zenwave360/vistas-eventflow-webview...', 'build'],
    },
  ];
  assert.deepEqual(
    SIBLING_BUILDS.map((build: { directory: string; args: string[] }) => ({ directory: build.directory, args: build.args })),
    expected,
  );

  for (const build of SIBLING_BUILDS) {
    const windows = siblingBuildCommand(root, build, 'win32');
    const posix = siblingBuildCommand(root, build, 'linux');
    assert.equal(windows.directory, join(workspace, build.directory));
    assert.equal(posix.directory, join(workspace, build.directory));
    assert.deepEqual(windows.args, build.args);
    assert.deepEqual(posix.args, build.args);
    assert.equal(windows.shell, true);
    assert.equal(posix.shell, false);
    if (build.tool === 'pnpm') {
      assert.equal(windows.command, 'pnpm');
      assert.equal(posix.command, 'pnpm');
      continue;
    }
    assert.equal(windows.command, `"${join(workspace, build.directory, 'gradlew.bat')}"`);
    assert.equal(posix.command, join(workspace, build.directory, 'gradlew'));
  }
});

test('a Windows gradlew.bat under a directory with a space is quoted for cmd.exe', () => {
  const root = join(workspace, 'my workspace', 'zenwave-platform-vscode');
  const build = SIBLING_BUILDS.find((entry: { directory: string }) => entry.directory === 'dsl-kotlin');
  assert.ok(build);
  const checkout = join(workspace, 'my workspace', 'dsl-kotlin');
  const windows = siblingBuildCommand(root, build, 'win32');
  const posix = siblingBuildCommand(root, build, 'linux');

  assert.match(checkout, / /);
  assert.equal(windows.directory, checkout);
  assert.equal(windows.command, `"${join(checkout, 'gradlew.bat')}"`);
  assert.deepEqual(windows.args, build.args);
  assert.equal(windows.shell, true);
  assert.equal(posix.directory, checkout);
  assert.equal(posix.command, join(checkout, 'gradlew'));
  assert.deepEqual(posix.args, build.args);
  assert.equal(posix.shell, false);
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
