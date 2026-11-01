import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
// @ts-expect-error A build script without type declarations.
import { raisePins, raisePinsText } from '../../scripts/raise-pins.mjs';
import {
  aboveStableProblems,
  channelProblems,
  latestStable,
  pinProblems,
  releaseProblems,
  stampChangelog,
  stampVersion,
  // @ts-expect-error A build script without type declarations.
} from '../../scripts/release-rules.mjs';

const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: '0.1.0',
  dependencies: { '@zenwave360/dsl': '1.10.0', mermaid: '12.2.0' },
  devDependencies: {
    '@zenwave360/lsp-js': '0.1.0-next.13.1',
    '@zenwave360/vistas-eventflow-webview': '0.0.0-next-20261101112236',
  },
  zenwaveLanguageServer: { package: '@zenwave360/lsp-js', version: '0.1.0-next.13.1' },
  zenwaveEventFlowWebview: {
    package: '@zenwave360/vistas-eventflow-webview',
    version: '0.0.0-next-20261101112236',
    protocol: 'zenwave.eventflow.webview',
  },
  ...overrides,
});

const lockFor = (versions: Record<string, string>) => ({
  packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])),
});
const consistentLock = lockFor({
  '@zenwave360/dsl': '1.10.0',
  '@zenwave360/lsp-js': '0.1.0-next.13.1',
  '@zenwave360/vistas-eventflow-webview': '0.0.0-next-20261101112236',
});

test('R-R8 a pre-release needs an odd minor and a stable release an even one', () => {
  assert.deepEqual(channelProblems('0.1.0', 'pre-release'), []);
  assert.deepEqual(channelProblems('0.2.0', 'stable'), []);
  assert.match(channelProblems('0.2.0', 'pre-release')[0], /even minor.*raise the minor/);
  assert.match(channelProblems('0.3.0', 'stable')[0], /odd minor/);
  assert.match(channelProblems('0.1', 'stable')[0], /not major.minor.patch/);
});

test('R-R8 the stamp replaces only the patch and keeps the file as it was', () => {
  const text = '{\r\n  "name": "x",\r\n  "version": "0.1.0",\r\n  "engines": { "vscode": "^1.90.0", "version": "9.9.9" }\r\n}\r\n';
  const stamped = stampVersion(text, 57);
  assert.equal(stamped.version, '0.1.57');
  assert.equal(stamped.text, text.replace('"version": "0.1.0"', '"version": "0.1.57"'));
  assert.throws(() => stampVersion(text, 0), /positive integer/);
  assert.throws(() => stampVersion('{ "version": "next" }', 1), /no top-level "version"/);
});

test('R-R8 a pre-release stays above the latest stable release', () => {
  const tags = ['v0.1.99-pre', 'v0.2.0', 'v0.2.1', 'not-a-tag', 'v0.3.4-pre'];
  assert.deepEqual(latestStable(tags), { major: 0, minor: 2, patch: 1 });
  assert.equal(latestStable(['v0.1.1-pre']), undefined);
  assert.match(aboveStableProblems('0.1.5', tags)[0], /not above the stable release 0\.2\.1.*0\.3\.0/);
  assert.match(aboveStableProblems('0.2.7', tags)[0], /not above/);
  assert.deepEqual(aboveStableProblems('0.3.0', tags), []);
  assert.deepEqual(aboveStableProblems('0.1.0', []), []);
});

test('R-R10 the changelog heading becomes the stamped version and date, and its absence fails', () => {
  const text = '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Added\r\n- x\r\n\r\n## [0.1.0] - 2026-09-15\r\n';
  assert.equal(
    stampChangelog(text, '0.1.57', '2026-11-02'),
    '# Changelog\r\n\r\n## [0.1.57] - 2026-11-02\r\n\r\n### Added\r\n- x\r\n\r\n## [0.1.0] - 2026-09-15\r\n',
  );
  assert.throws(() => stampChangelog('# Changelog\n\n## [0.1.0] - 2026-09-15\n', '0.1.57', '2026-11-02'), /no "## \[Unreleased\]"/);
});

test('R-R9 exact next pins, agreeing everywhere, pass', () => {
  assert.deepEqual(pinProblems(manifest(), { lock: consistentLock }), []);
});

test('R-R9 a moving tag fails and names the dependency', () => {
  const problems = pinProblems(manifest({ devDependencies: { '@zenwave360/lsp-js': 'next' } }));
  assert.ok(problems.some((problem: string) => /@zenwave360\/lsp-js is "next" in devDependencies/.test(problem)), problems.join('\n'));
  assert.ok(pinProblems(manifest({ dependencies: { '@zenwave360/dsl': '^1.10.0' } })).some((p: string) => /dsl is "\^1\.10\.0"/.test(p)));
  assert.ok(pinProblems(manifest({ dependencies: { '@zenwave360/dsl': 'latest' } })).some((p: string) => /"latest"/.test(p)));
});

test('R-R9 blocks that disagree with package.json fail and name both', () => {
  const problems = pinProblems(
    manifest({ zenwaveLanguageServer: { package: '@zenwave360/lsp-js', version: '0.1.0-next.12.1' } }),
  );
  assert.deepEqual(problems, [
    '@zenwave360/lsp-js is 0.1.0-next.13.1 in package.json but 0.1.0-next.12.1 in zenwaveLanguageServer',
  ]);
});

test('R-R9 a lockfile that disagrees, or links a sibling, fails', () => {
  const stale = lockFor({
    '@zenwave360/dsl': '1.10.0',
    '@zenwave360/lsp-js': '0.1.0-next.12.1',
    '@zenwave360/vistas-eventflow-webview': '0.0.0-next-20261101112236',
  });
  assert.deepEqual(pinProblems(manifest(), { lock: stale }), [
    '@zenwave360/lsp-js is 0.1.0-next.13.1 in package.json but 0.1.0-next.12.1 in package-lock.json',
  ]);
  const linked = { packages: { ...consistentLock.packages, 'node_modules/@zenwave360/dsl': { link: true } } };
  assert.match(pinProblems(manifest(), { lock: linked })[0], /dsl is 1\.10\.0 in package\.json but a link/);
});

test('R-R11 a stable release refuses every next pin and names it', () => {
  const problems = pinProblems(manifest(), { stable: true });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /@zenwave360\/lsp-js is 0\.1\.0-next\.13\.1 .* stable version/);
  const stable = manifest({
    devDependencies: { '@zenwave360/lsp-js': '0.1.0' },
    zenwaveLanguageServer: { package: '@zenwave360/lsp-js', version: '0.1.0' },
    zenwaveEventFlowWebview: undefined,
  });
  assert.deepEqual(pinProblems(stable, { stable: true }), []);
});

test('R-R11 only a stable-shaped tag that matches the manifest releases', () => {
  const stable = manifest({ version: '0.2.0', devDependencies: {}, zenwaveLanguageServer: undefined, zenwaveEventFlowWebview: undefined });
  const base = { channel: 'stable', manifest: stable, changelog: '## [0.2.0] - 2026-12-01\n' };
  assert.deepEqual(releaseProblems({ ...base, tag: 'v0.2.0' }), []);
  assert.match(releaseProblems({ ...base, tag: 'v0.2.1' })[0], /does not match package version 0\.2\.0/);
  assert.match(releaseProblems({ ...base, tag: 'v0.1.99-pre' })[0], /not a stable release tag/);
  assert.match(releaseProblems({ ...base, tag: undefined })[0], /not a stable release tag/);
  assert.match(releaseProblems({ ...base, tag: 'v0.2.0', changelog: '## [0.1.0]\n' }).join(), /no "## \[0\.2\.0\]" section/);
  assert.match(releaseProblems({ ...base, tag: 'v0.2.0', linked: ['@zenwave360/dsl'] }).join(), /sibling builds: @zenwave360\/dsl/);
});

test('R-R10 a pre-release needs an Unreleased section before the stamp and its version after', () => {
  const base = { channel: 'pre-release', manifest: manifest(), lock: consistentLock };
  assert.deepEqual(releaseProblems({ ...base, changelog: '## [Unreleased]\n', changelogHeading: 'Unreleased' }), []);
  assert.deepEqual(releaseProblems({ ...base, changelog: '## [0.1.0] - x\n' }), []);
  assert.match(releaseProblems({ ...base, changelog: '## [0.1.0] - x\n', changelogHeading: 'Unreleased' })[0], /no "## \[Unreleased\]"/);
  assert.match(releaseProblems({ ...base, manifest: manifest({ version: '0.2.0' }), changelog: '' })[0], /even minor/);
});

test('the pins committed in this repository pass the pre-release checks', () => {
  const root = join(import.meta.dirname, '../../../..');
  const real = JSON.parse(readFileSync(join(root, 'packages/extension/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(pinProblems(real, { lock }), []);
  assert.deepEqual(channelProblems(real.version, 'pre-release'), []);
});

// The pin-raising script, with npm replaced by what a test chooses.
let workspace: string;
const SOURCE = [
  '{',
  '  "version": "0.1.0",',
  '  "zenwaveLanguageServer": {',
  '    "package": "@zenwave360/lsp-js",',
  '    "version": "0.1.0-next.12.1"',
  '  },',
  '  "zenwaveEventFlowWebview": {',
  '    "package": "@zenwave360/vistas-eventflow-webview",',
  '    "version": "0.1.0",',
  '    "protocolVersion": 1',
  '  },',
  '  "devDependencies": {',
  '    "@zenwave360/lsp-js": "0.1.0-next.12.1",',
  '    "@zenwave360/vistas-eventflow-webview": "0.1.0"',
  '  },',
  '  "dependencies": {',
  '    "@zenwave360/dsl": "1.10.0"',
  '  }',
  '}',
  '',
].join('\r\n');

const LOCK = `${JSON.stringify(
  {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@zenwave360/lsp-js': { version: '0.1.0-next.12.1' },
      'node_modules/@zenwave360/vistas-eventflow-webview': { version: '0.1.0' },
      'node_modules/@zenwave360/dsl': { version: '1.10.0' },
    },
  },
  null,
  2,
).replaceAll('\n', '\r\n')}\r\n`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zenwave-pins-'));
  mkdirSync(join(workspace, 'packages/extension'), { recursive: true });
  writeFileSync(join(workspace, 'packages/extension/package.json'), SOURCE);
  writeFileSync(join(workspace, 'package-lock.json'), LOCK);
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const NEXT: Record<string, string> = {
  '@zenwave360/lsp-js': '0.1.0-next.13.1',
  '@zenwave360/vistas-eventflow-webview': '0.0.0-next-20261101112236',
  '@zenwave360/dsl': '1.11.0-next.13.1',
};

test('R-R9 raising writes every place a pin lives, keeps the formatting, and leaves dsl alone', () => {
  const synced: string[] = [];
  const lines = raisePins({
    extensionDirectory: join(workspace, 'packages/extension'),
    root: workspace,
    latest: (name: string) => NEXT[name],
    syncLock: (root: string) => synced.push(root),
  });
  const text = readFileSync(join(workspace, 'packages/extension/package.json'), 'utf8');
  assert.equal(
    text,
    SOURCE.replace('"0.1.0-next.12.1"', '"0.1.0-next.13.1"')
      .replace('"0.1.0-next.12.1"', '"0.1.0-next.13.1"')
      .replace('"version": "0.1.0",\r\n    "protocolVersion"', '"version": "0.0.0-next-20261101112236",\r\n    "protocolVersion"')
      .replace('"@zenwave360/vistas-eventflow-webview": "0.1.0"', '"@zenwave360/vistas-eventflow-webview": "0.0.0-next-20261101112236"'),
  );
  assert.deepEqual(pinProblems(JSON.parse(text)), []);
  assert.equal(JSON.parse(text).dependencies['@zenwave360/dsl'], '1.10.0');
  assert.deepEqual(synced, [workspace]);
  // npm re-resolves what the lockfile forgot, so the new version is hoisted; dsl keeps its entry, and the file keeps its line ends.
  const lock = readFileSync(join(workspace, 'package-lock.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(lock).packages), ['', 'node_modules/@zenwave360/dsl']);
  assert.ok(lock.includes('\r\n') && !/[^\r]\n/.test(lock));
  assert.deepEqual(lines, [
    '@zenwave360/lsp-js: 0.1.0-next.12.1 -> 0.1.0-next.13.1',
    '@zenwave360/vistas-eventflow-webview: 0.1.0 -> 0.0.0-next-20261101112236',
  ]);
});

test('R-R9 dsl is raised only when named, and nothing is written when nothing changes or on a dry run', () => {
  const extensionDirectory = join(workspace, 'packages/extension');
  const synced: string[] = [];
  const options = { extensionDirectory, root: workspace, latest: (name: string) => NEXT[name], syncLock: (root: string) => synced.push(root) };
  raisePins({ ...options, dryRun: true, include: ['@zenwave360/dsl'] });
  assert.equal(readFileSync(join(workspace, 'packages/extension/package.json'), 'utf8'), SOURCE);
  assert.deepEqual(synced, []);

  raisePins({ ...options, include: ['@zenwave360/dsl'] });
  assert.equal(JSON.parse(readFileSync(join(workspace, 'packages/extension/package.json'), 'utf8')).dependencies['@zenwave360/dsl'], '1.11.0-next.13.1');

  synced.length = 0;
  const again = raisePins({ ...options, include: ['@zenwave360/dsl'] });
  assert.ok(again.every((line: string) => line.endsWith('is already next')), again.join('\n'));
  assert.deepEqual(synced, []);
});

test('R-R9 raising refuses a package the extension does not use, and a version that is not exact', () => {
  assert.throws(
    () => raisePins({ extensionDirectory: join(workspace, 'packages/extension'), root: workspace, include: ['@zenwave360/nope'], latest: () => '1.0.0' }),
    /Not a dependency of the extension: @zenwave360\/nope/,
  );
  assert.throws(() => raisePinsText(SOURCE, { '@zenwave360/lsp-js': 'next' }), /not an exact version/);
});
