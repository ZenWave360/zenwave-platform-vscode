import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
// @ts-expect-error A build script without type declarations.
import { raisePins, raisePinsText } from '../../scripts/raise-pins.mjs';
import {
  buildChangelog,
  latestStable,
  nextStableVersion,
  nextNotesProblems,
  notesProblems,
  parseExtensionVersion,
  pinProblems,
  prepareProblems,
  releaseNotesText,
  releaseProblems,
  setLockVersion,
  setVersion,
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

const preRelease = (version: string, tags: string[] | undefined, runNumber?: number) =>
  releaseProblems({ channel: 'pre-release', manifest: manifest({ version }), tags, runNumber, notes: { next: '' } });

test('R-R8 a pre-release is the manifest major.minor and the run number, with no offset and no padding', () => {
  assert.equal(stampVersion('{\n  "version": "0.0.0"\n}\n', 57).version, '0.0.57');
  assert.equal(stampVersion('{\n  "version": "0.1.0"\n}\n', 58).version, '0.1.58');
  assert.equal(stampVersion('{\n  "version": "0.1.0"\n}\n', 5).version, '0.1.5');
  assert.deepEqual(preRelease('0.0.0', [], 57), []);
  assert.deepEqual(preRelease('0.1.0', ['v0.1.0'], 58), []);
  // Any minor is a stable release: nothing is odd or even.
  assert.deepEqual(preRelease('0.2.0', ['v0.2.0'], 3), []);
  assert.deepEqual(preRelease('0.3.0', ['v0.3.0'], 3), []);
  assert.match(preRelease('0.1', undefined)[0], /not major.minor.patch/);
});

test('R-R8 a manifest that was not merged back from main fails before building', () => {
  const problems = preRelease('0.0.0', ['v0.1.0'], 60);
  assert.match(problems[0], /0\.0\.0.*major\.minor of the last stable release, 0\.1 \(v0\.1\.0\).*merge main back/);
  // And a stable release is not expected before the first one.
  assert.match(preRelease('0.1.0', [], 60)[0], /0\.0.*as there is none yet.*merge main back/);
  assert.match(preRelease('0.2.0', ['v0.1.0', 'v0.1.4-pre'], 1)[0], /0\.1 \(v0\.1\.0\)/);
});

test('R-R8 the stamped version must be above the highest stable tag, and a hotfix takes a low patch', () => {
  const tags = ['v0.1.0', 'v0.1.99-pre', 'not-a-tag'];
  assert.deepEqual(preRelease('0.1.0', tags, 60), []);
  assert.deepEqual(preRelease('0.1.0', ['v0.1.0', 'v0.1.1'], 60), []);
  const high = preRelease('0.1.0', ['v0.1.0', 'v0.1.1057'], 60);
  assert.equal(high.length, 1);
  assert.match(high[0], /0\.1\.60 is not above the stable release 0\.1\.1057.*hotfix.*v0\.1\.1, never one above the run numbers/);
  assert.match(preRelease('0.1.0', ['v0.1.60'], 60)[0], /not above/);
});

test('R-R8 the hotfix message appears only for a manifest at the stable major.minor, and clears when the run number passes the patch', () => {
  // Not merged back: the remedy is "merge main back", and a hotfix is not mentioned.
  for (const [version, tags] of [['0.0.0', ['v0.1.0']], ['0.1.0', ['v1.0.0']], ['0.0.0', ['v9.9.9']]] as const) {
    const problems = preRelease(version, [...tags], 60);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /merge main back/);
    assert.ok(!/hotfix/.test(problems[0]));
  }
  // A high hotfix fails until the run number is above its patch.
  const tags = ['v0.2.1057'];
  assert.match(preRelease('0.2.0', tags, 1057)[0], /fails until a run number is above 1057/);
  assert.deepEqual(preRelease('0.2.0', tags, 1058), []);
});

test('R-R8 the highest stable tag counts every stable-shaped tag, in semantic order, and never a -pre tag', () => {
  const tags = ['v0.9.0', 'v0.10.0', 'v0.2.7', 'v0.10.0-pre', 'v0.11.5-pre', 'v1.0', 'not-a-tag'];
  assert.deepEqual(latestStable(tags), { major: 0, minor: 10, patch: 0 });
  assert.deepEqual(latestStable(['v0.1.5']), { major: 0, minor: 1, patch: 5 });
  assert.deepEqual(latestStable(['v0.3.9', 'v0.2.0']), { major: 0, minor: 3, patch: 9 });
  assert.equal(latestStable(['v0.1.1-pre']), undefined);
  assert.equal(latestStable([]), undefined);
});

test('R-R10 a pre-release needs next.md, which may be empty', () => {
  const base = { channel: 'pre-release', manifest: manifest(), lock: consistentLock };
  assert.deepEqual(notesProblems({ channel: 'pre-release', version: '0.0.1', notes: { next: '' } }), []);
  assert.match(releaseProblems({ ...base, notes: {} })[0], /release-notes\/next\.md is missing; it may be empty/);
});

test('R-R10 the changelog has the full notes, highest version first, in semantic order', () => {
  const releases = [
    { version: '0.9.0', date: '2026-01-01', text: '### Added\r\n- nine\r\n' },
    { version: '0.10.0', date: '2026-02-01', text: '- ten\n' },
    { version: '0.2.1', date: '2026-01-15', text: '' },
  ];
  assert.equal(
    buildChangelog({ next: { heading: '## [0.10.57] - 2026-03-01', text: '- next\n' }, releases }),
    '# Changelog\n\n## [0.10.57] - 2026-03-01\n\n- next\n\n## [0.10.0] - 2026-02-01\n\n- ten\n\n' +
      '## [0.9.0] - 2026-01-01\n\n### Added\n- nine\n\n## [0.2.1] - 2026-01-15\n',
  );
  // An empty next.md leaves a heading with nothing under it, and no stable build includes next.md.
  assert.equal(buildChangelog({ next: { heading: '## [Unreleased]', text: '' }, releases: [] }), '# Changelog\n\n## [Unreleased]\n');
  assert.equal(buildChangelog({ releases: releases.slice(2) }), '# Changelog\n\n## [0.2.1] - 2026-01-15\n');
});

/** A scratch repository with the release scripts, one commit, and notes; tests choose the files and the commit date. */
function scratchRepository(files: Record<string, string>, date = '2026-03-04T23:30:00+02:00') {
  const repo = mkdtempSync(join(tmpdir(), 'zenwave-release-'));
  const scripts = join(repo, 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['release.mjs', 'release-rules.mjs', 'release-notes.mjs', 'siblings.mjs']) {
    writeFileSync(join(scripts, file), readFileSync(join(import.meta.dirname, '../../scripts', file)));
  }
  const lock = { packages: { '': { name: 'zenwave-platform', version: '0.0.0', license: 'MIT' } } };
  writeFileSync(join(repo, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date,
    GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  };
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'x');
  const release = (...args: string[]) =>
    spawnSync(process.execPath, [join(scripts, 'release.mjs'), ...args], { cwd: repo, env, encoding: 'utf8' });
  return { repo, git, release, env, scripts, extension: repo };
}

test('R-R10 the generated changelog is deterministic, dated by the commits, and a stable release uses the date of its tag', () => {
  const extensionFiles = {
    'package.json': '{\n  "version": "0.1.0"\n}\n',
    'release-notes/next.md': '- next\n',
    'release-notes/release-notes.v0.1.0.md': '- one\n',
    'release-notes/release-notes.v0.10.0.md': '- ten\n',
  };
  const { repo, git, env, extension } = scratchRepository(extensionFiles);
  try {
    const generate = (channel: string | undefined, version: string) => {
      const run = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `import { generateChangelog } from ${JSON.stringify(pathToFileURL(join(extension, 'scripts/release-notes.mjs')).href)};
          process.stdout.write(generateChangelog({ projectDir: ${JSON.stringify(extension)}, repositoryRoot: ${JSON.stringify(repo)}, channel: ${JSON.stringify(channel)}, version: ${JSON.stringify(version)} }));`],
        { env, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(extension, 'CHANGELOG.md'), 'utf8'), run.stdout);
      return run.stdout;
    };
    // No tag: every stable section has the date of HEAD.
    const pre = generate('pre-release', '0.0.57');
    assert.equal(
      pre,
      '# Changelog\n\n## [0.0.57] - 2026-03-04\n\n- next\n\n## [0.10.0] - 2026-03-04\n\n- ten\n\n## [0.1.0] - 2026-03-04\n\n- one\n',
    );
    assert.equal(generate('pre-release', '0.0.57'), pre);
    assert.match(generate(undefined, '0.0.0'), /^# Changelog\n\n## \[Unreleased\]\n\n- next\n\n## \[0\.10\.0\]/);
    // A tag on an older commit gives its section that commit's date; a stable build leaves next.md out.
    git('tag', 'v0.1.0');
    writeFileSync(join(repo, 'later.txt'), 'x');
    git('add', 'later.txt');
    const later = { ...env, GIT_COMMITTER_DATE: '2026-05-06T10:00:00+00:00', GIT_AUTHOR_DATE: '2026-05-06T10:00:00+00:00' };
    const commit = spawnSync('git', ['commit', '-q', '-m', 'later'], { cwd: repo, env: later, encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    const stable = generate('stable', '0.10.0');
    assert.equal(stable, '# Changelog\n\n## [0.10.0] - 2026-05-06\n\n- ten\n\n## [0.1.0] - 2026-03-04\n\n- one\n');
    assert.equal(generate('stable', '0.10.0'), stable);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R-R8 the stamp changes only the version and commits nothing', () => {
  const manifestText = '{\r\n  "version": "0.1.0",\r\n  "engines": { "version": "9.9.9" }\r\n}\r\n';
  const { repo, release, extension } = scratchRepository({ 'package.json': manifestText });
  try {
    const run = release('stamp', '--run-number', '58');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '0.1.58');
    assert.equal(readFileSync(join(extension, 'package.json'), 'utf8'), manifestText.replace('"0.1.0"', '"0.1.58"'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const stableManifest = (version = '0.2.0') =>
  manifest({ version, devDependencies: {}, zenwaveLanguageServer: undefined, zenwaveEventFlowWebview: undefined });

test('R-R11 only a stable-shaped tag that matches the manifest releases, on any minor', () => {
  const base = { channel: 'stable', manifest: stableManifest(), notes: { release: '- x\n' } };
  assert.deepEqual(releaseProblems({ ...base, tag: 'v0.2.0' }), []);
  assert.deepEqual(releaseProblems({ ...base, manifest: stableManifest('0.3.0'), tag: 'v0.3.0' }), []);
  assert.match(releaseProblems({ ...base, tag: 'v0.2.1' })[0], /does not match package version 0\.2\.0/);
  assert.match(releaseProblems({ ...base, tag: 'v0.1.99-pre' })[0], /not a stable release tag/);
  assert.match(releaseProblems({ ...base, tag: undefined })[0], /not a stable release tag/);
  assert.match(releaseProblems({ ...base, tag: 'v0.2.0', linked: ['@zenwave360/dsl'] }).join(), /sibling builds: @zenwave360\/dsl/);
});

test('R-R11 a stable release refuses missing, empty and draft notes, and an existing -pre tag', () => {
  const base = { channel: 'stable', manifest: stableManifest(), tag: 'v0.2.0' };
  assert.match(releaseProblems({ ...base, notes: {} })[0], /release-notes\.v0\.2\.0\.md is missing/);
  assert.match(releaseProblems({ ...base, notes: { release: '' } })[0], /is empty/);
  assert.match(releaseProblems({ ...base, notes: { release: '\r\n  \n' } })[0], /is empty/);
  assert.match(releaseProblems({ ...base, notes: { release: '\n# DRAFT release notes\n- x\n' } })[0], /marked as a draft/);
  assert.match(releaseProblems({ ...base, notes: { release: 'Draft: x' } })[0], /marked as a draft/);
  // Only the first heading and the first line that is not a heading say whether it is a draft.
  assert.deepEqual(releaseProblems({ ...base, notes: { release: '# 0.2.0\n- fixes the cache\n- fixes the draft preview\n' } }), []);
  assert.match(releaseProblems({ ...base, notes: { release: '# 0.2.0\n- fixes the draft preview\n' } })[0], /marked as a draft/);
  assert.match(releaseProblems({ ...base, notes: { release: '- x' }, tags: ['v0.2.0-pre'] })[0], /v0\.2\.0-pre exists/);
  assert.deepEqual(releaseProblems({ ...base, notes: { release: '- x' }, tags: ['v0.1.0-pre', 'v0.2.1-pre', 'v0.1.0'] }), []);
});

test('R-R11 a stable release must be above every other stable tag', () => {
  const base = { channel: 'stable', notes: { release: '- x' } };
  const stableAt = (version: string, tags: string[]) =>
    releaseProblems({ ...base, manifest: stableManifest(version), tag: `v${version}`, tags });
  // The tag being built is among the tags and is not "another".
  assert.deepEqual(stableAt('0.3.0', ['v0.2.0', 'v0.3.0']), []);
  assert.match(stableAt('0.3.5', ['v1.0.0', 'v0.3.5'])[0], /0\.3\.5 is not above the stable release 1\.0\.0 \(v1\.0\.0\).*above every other/);
  assert.match(stableAt('0.2.0', ['v0.2.1', 'v0.2.0'])[0], /not above the stable release 0\.2\.1/);
  assert.deepEqual(stableAt('0.2.0', ['v0.3.0-pre', 'v0.2.0']), []);
});

test('decision 0024 a number with a leading zero is not a version or a tag', () => {
  for (const version of ['01.0.0', '0.01.0', '0.1.01', '1.0.00']) {
    assert.equal(parseExtensionVersion(version), undefined, version);
    assert.match(prepareProblems(version, [])[0], /not major\.minor\.patch/);
  }
  assert.deepEqual(parseExtensionVersion('0.10.0'), { major: 0, minor: 10, patch: 0 });
  assert.equal(latestStable(['v01.0.0', 'v0.1.01']), undefined);
  assert.deepEqual(latestStable(['v01.0.0', 'v0.2.0']), { major: 0, minor: 2, patch: 0 });
  assert.match(pinProblems(manifest({ dependencies: { '@zenwave360/dsl': '01.10.0' } }))[0], /pin an exact version/);
  assert.throws(() => stampVersion('{\n  "version": "0.01.0"\n}\n', 3), /no top-level "version"/);
  const { repo, release } = scratchRepository({
    'package.json': '{\n  "version": "0.0.0"\n}\n',
    'release-notes/release-notes.v0.01.0.md': '- ignored\n',
    'release-notes/next.md': '',
  });
  try {
    // A file name with a leading zero is not the notes of a release.
    assert.equal(release('notes', '--channel', 'stable').stdout, '');
    assert.match(release('check', '--channel', 'stable', '--tag', 'v0.01.0').stderr, /not a stable release tag/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R-R11 "has content" is a line that is not a heading, and a draft is named by the first heading or the first line', () => {
  const stable = (release: string) => releaseProblems({ channel: 'stable', manifest: stableManifest(), tag: 'v0.2.0', notes: { release } });
  assert.match(stable('### Added\n\n')[0], /is empty: it needs a line that is not a heading/);
  assert.match(stable('# 0.2.0\n## Fixed\n###\n')[0], /is empty/);
  assert.deepEqual(stable('### Added\n- x\n'), []);
  assert.deepEqual(stable('    indented text\n'), []);
  // The first heading, wherever it is, and the first non-blank line.
  assert.match(stable('Notes follow.\n# Draft\n- x\n')[0], /marked as a draft: "# Draft"/);
  assert.match(stable('# Release\nDRAFT: not final\n- x\n')[0], /marked as a draft: "DRAFT: not final"/);
  // A later line, and words that only contain "draft".
  assert.deepEqual(stable('# Release\n- x\n- the draft preview\n'), []);
  assert.deepEqual(stable('- Overdraft domain sample\n'), []);
});

test('R-R15 next.md must exist, have content and not be a draft before a release is prepared', () => {
  assert.deepEqual(nextNotesProblems('### Fixed\n- x\n'), []);
  assert.match(nextNotesProblems(undefined)[0], /release-notes\/next\.md is missing/);
  assert.match(nextNotesProblems('')[0], /release-notes\/next\.md is empty/);
  assert.match(nextNotesProblems('### Added\n\n')[0], /is empty: it needs a line that is not a heading/);
  assert.match(nextNotesProblems('# Draft\n- x\n')[0], /release-notes\/next\.md is marked as a draft/);
  assert.deepEqual(nextNotesProblems('# Release\n- x\n- the draft preview\n'), []);
});

test('R-R15 the check-next-notes command fails on a missing, empty or draft next.md and names the file', () => {
  const { repo, release, extension } = scratchRepository({ 'package.json': '{\n  "version": "0.1.0"\n}\n', 'release-notes/next.md': '- a fix\n' });
  try {
    const ok = release('check-next-notes');
    assert.equal(ok.status, 0, ok.stderr);
    writeFileSync(join(extension, 'release-notes/next.md'), '');
    const empty = release('check-next-notes');
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /error: release-notes\/next\.md is empty/);
    writeFileSync(join(extension, 'release-notes/next.md'), 'DRAFT\n- x\n');
    assert.match(release('check-next-notes').stderr, /release-notes\/next\.md is marked as a draft/);
    rmSync(join(extension, 'release-notes/next.md'));
    assert.match(release('check-next-notes').stderr, /release-notes\/next\.md is missing/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R-R10 the GitHub release text is the notes file, whole', () => {
  const tricky = '## [Unreleased]\n- a\n\n## [Breaking] changes\n- b\n\n```md\n## [1.0.0] - 2026-01-01\n```\n';
  assert.equal(releaseNotesText({ channel: 'pre-release', notes: { next: tricky } }), tricky);
  assert.equal(releaseNotesText({ channel: 'stable', notes: { release: '\r\n- x\r\n\r\n', next: 'no' } }), '- x\n');
  assert.equal(releaseNotesText({ channel: 'pre-release', notes: { next: '\n  \n' } }), '');
  assert.equal(releaseNotesText({ channel: 'pre-release', notes: {} }), '');
  assert.equal(releaseNotesText({ channel: 'development', notes: { next: '- x' } }), '');
});

test('R-R10 the notes command prints next.md for a pre-release and the stable notes of the manifest version', () => {
  const tricky = '## [Unreleased]\n- a\n\n## [Breaking] changes\n- b\n\n```md\n## [1.0.0] - 2026-01-01\n```\n';
  const { repo, release, extension } = scratchRepository({
    'package.json': '{\n  "version": "0.1.71"\n}\n',
    'release-notes/next.md': tricky,
    'release-notes/release-notes.v0.1.71.md': '- stable\n',
  });
  try {
    const pre = release('notes', '--channel', 'pre-release');
    assert.equal(pre.status, 0, pre.stderr);
    assert.equal(pre.stdout, tricky);
    assert.equal(release('notes', '--channel', 'stable').stdout, '- stable\n');
    assert.equal(release('notes', '--channel', 'development').stdout, '');
    assert.notEqual(release('notes', '--channel', 'nope').status, 0);
    writeFileSync(join(extension, 'release-notes/next.md'), '');
    assert.equal(release('notes', '--channel', 'pre-release').stdout, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R-R11 prepare sets the version and the notes, refusing a version that is not above the highest stable tag', () => {
  assert.deepEqual(prepareProblems('0.1.0', []), []);
  assert.deepEqual(prepareProblems('0.1.1', ['v0.1.0', 'v0.2.0-pre']), []);
  assert.match(prepareProblems('0.1.0', ['v0.1.0'])[0], /not above the stable release 0\.1\.0/);
  assert.match(prepareProblems('0.1.9', ['v0.2.0'])[0], /not above the stable release 0\.2\.0/);
  assert.match(prepareProblems('0.1.0', [], { targetExists: true })[0], /release-notes\.v0\.1\.0\.md already exists/);
  assert.match(prepareProblems('0.1', [])[0], /not major.minor.patch/);
  const lock = (version: string) =>
    `{\n  "name": "z",\n  "version": "${version}",\n  "packages": {\n    "": {\n      "name": "z",\n      "version": "${version}",\n      "dependencies": { "a": "1.0.0" }\n    }\n  }\n}\n`;
  assert.equal(setLockVersion(lock('0.0.0'), '0.2.0'), lock('0.2.0'));
  assert.throws(() => setLockVersion('{ "packages": {} }', '0.2.0'), /no root package entry/);
  assert.match(prepareProblems('0.2.0', [], { nextExists: false })[0], /release-notes\/next\.md is missing/);
  assert.equal(setVersion('{\n  "version": "0.0.0",\n  "x": { "version": "9.9.9" }\n}\n', '0.1.0'), '{\n  "version": "0.1.0",\n  "x": { "version": "9.9.9" }\n}\n');
});

test('R-R11 the prepare command moves next.md, leaves an empty one, and commits nothing', () => {
  const { repo, release, git, extension } = scratchRepository({
    'package.json': '{\n  "version": "0.0.0"\n}\n',
    'release-notes/next.md': '- the notes\n',
  });
  try {
    const refused = release('prepare', '0.1');
    assert.notEqual(refused.status, 0);
    git('tag', 'v0.1.0');
    const old = release('prepare', '0.1.0');
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /not above the stable release 0\.1\.0/);
    assert.equal(readFileSync(join(extension, 'release-notes/next.md'), 'utf8'), '- the notes\n');

    const done = release('prepare', '0.2.0');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(readFileSync(join(extension, 'package.json'), 'utf8'), '{\n  "version": "0.2.0"\n}\n');
    assert.equal(JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).packages[''].version, '0.2.0');
    assert.equal(readFileSync(join(extension, 'release-notes/release-notes.v0.2.0.md'), 'utf8'), '- the notes\n');
    assert.equal(readFileSync(join(extension, 'release-notes/next.md'), 'utf8'), '');
    const log = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' });
    assert.equal(log.stdout.trim().split('\n').length, 1);

    // Without next.md nothing changes.
    rmSync(join(extension, 'release-notes/next.md'));
    const missing = release('prepare', '0.3.0');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /next\.md is missing/);
    assert.equal(readFileSync(join(extension, 'package.json'), 'utf8'), '{\n  "version": "0.2.0"\n}\n');
    writeFileSync(join(extension, 'release-notes/next.md'), '');

    // The target notes now exist: a second prepare of the same version, even above the tag, refuses and changes nothing.
    writeFileSync(join(extension, 'release-notes/next.md'), '- more\n');
    const again = release('prepare', '0.2.0');
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(readFileSync(join(extension, 'release-notes/next.md'), 'utf8'), '- more\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R-R8 and R-R11 the check command reads the tags of the repository', () => {
  const { repo, release, git, extension } = scratchRepository({
    'package.json': '{\n  "version": "0.0.0"\n}\n',
    'release-notes/next.md': '',
  });
  try {
    assert.equal(release('check', '--channel', 'pre-release', '--git-tags', '--run-number', '57').status, 0);
    git('tag', 'v0.1.0');
    const notMerged = release('check', '--channel', 'pre-release', '--git-tags', '--run-number', '57');
    assert.equal(notMerged.status, 1);
    assert.match(notMerged.stderr, /merge main back/);
    writeFileSync(join(extension, 'package.json'), '{\n  "version": "0.1.0"\n}\n');
    assert.equal(release('check', '--channel', 'pre-release', '--git-tags', '--run-number', '58').status, 0);
    git('tag', 'v0.1.1057');
    assert.match(release('check', '--channel', 'pre-release', '--git-tags', '--run-number', '60').stderr, /v0\.1\.1, never one above/);
    // A stable release: notes needed, and the -pre tag of its version refuses it.
    writeFileSync(join(extension, 'package.json'), '{\n  "version": "0.2.0"\n}\n');
    assert.match(release('check', '--channel', 'stable', '--tag', 'v0.2.0', '--git-tags').stderr, /release-notes\.v0\.2\.0\.md is missing/);
    writeFileSync(join(extension, 'release-notes/release-notes.v0.2.0.md'), '- x\n');
    assert.equal(release('check', '--channel', 'stable', '--tag', 'v0.2.0', '--git-tags').status, 0);
    git('tag', 'v0.2.0-pre');
    assert.match(release('check', '--channel', 'stable', '--tag', 'v0.2.0', '--git-tags').stderr, /v0\.2\.0-pre exists/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
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

test('the pins committed in this repository pass the pre-release checks', () => {
  const root = join(import.meta.dirname, '../..');
  const real = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(pinProblems(real, { lock }), []);
  assert.ok(parseExtensionVersion(real.version), real.version);
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
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), SOURCE);
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
    extensionDirectory: workspace,
    root: workspace,
    latest: (name: string) => NEXT[name],
    syncLock: (root: string) => synced.push(root),
  });
  const text = readFileSync(join(workspace, 'package.json'), 'utf8');
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
  const extensionDirectory = workspace;
  const synced: string[] = [];
  const options = { extensionDirectory, root: workspace, latest: (name: string) => NEXT[name], syncLock: (root: string) => synced.push(root) };
  raisePins({ ...options, dryRun: true, include: ['@zenwave360/dsl'] });
  assert.equal(readFileSync(join(workspace, 'package.json'), 'utf8'), SOURCE);
  assert.deepEqual(synced, []);

  raisePins({ ...options, include: ['@zenwave360/dsl'] });
  assert.equal(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).dependencies['@zenwave360/dsl'], '1.11.0-next.13.1');

  synced.length = 0;
  const again = raisePins({ ...options, include: ['@zenwave360/dsl'] });
  assert.ok(again.every((line: string) => line.endsWith('is already next')), again.join('\n'));
  assert.deepEqual(synced, []);
});

test('R-R9 raising refuses a package the extension does not use, and a version that is not exact', () => {
  assert.throws(
    () => raisePins({ extensionDirectory: workspace, root: workspace, include: ['@zenwave360/nope'], latest: () => '1.0.0' }),
    /Not a dependency of the extension: @zenwave360\/nope/,
  );
  assert.throws(() => raisePinsText(SOURCE, { '@zenwave360/lsp-js': 'next' }), /not an exact version/);
});

const commit = (message: string, merge = false, sha = `${Math.random().toString(16).slice(2, 9)}0000000000000000000000000000000`) => ({ sha, message, merge });
const nextOf = (tags: string[], messages: string[]) => nextStableVersion({ tags, commits: messages.map((message) => commit(message)) });

test('nextStableVersion: a fix gives a patch (spec:release#r-r14)', () => {
  const result = nextOf(['v0.2.0'], ['fix: x', 'chore: y']);
  assert.equal(result.version, '0.2.1');
  assert.equal(result.base, '0.2.0');
  assert.deepEqual(result.decidedBy.map(({ subject, effect }) => [subject, effect]), [['fix: x', 'fix']]);
});

test('nextStableVersion: a feature gives a minor, with or without a scope', () => {
  assert.equal(nextOf(['v0.2.0'], ['fix: x', 'chore: y', 'feat(eventflow): z']).version, '0.3.0');
  assert.equal(nextOf(['v0.2.0'], ['feat: z']).version, '0.3.0');
  assert.equal(nextOf(['v0.2.4'], ['fix(preview): z']).version, '0.2.5');
  assert.equal(nextOf(['v0.2.0'], ['feat(eventflow): z']).decidedBy[0].subject, 'feat(eventflow): z');
});

test('nextStableVersion: only other types release nothing', () => {
  const messages = ['chore: a', 'docs: b', 'test: c', 'refactor: d', 'perf: e', 'ci: f', 'build: g', 'style: h', 'Update the readme'];
  assert.deepEqual(nextOf(['v0.2.0'], messages), { version: null, base: '0.2.0', decidedBy: [] });
});

test('nextStableVersion: a milestone is asked for with a Release trailer', () => {
  const on = (trailer: string) => nextOf(['v0.7.2'], [`chore: milestone\n\nBody.\n\n${trailer}`]);
  assert.equal(on('Release: major').version, '1.0.0');
  assert.equal(on('Release: v1.0.0').version, '1.0.0');
  assert.equal(on('Release: 1.0.0').version, '1.0.0');
  assert.deepEqual(on('Release: major').decidedBy.map(({ effect }) => effect), ['Release: major']);
  assert.throws(() => on('Release: v0.5.0'), /not above the stable release 0\.7\.2/);
});

test('nextStableVersion: the Release-Run trailer of a release commit is not a Release trailer (spec:release#r-r15)', () => {
  assert.deepEqual(nextOf(['v0.2.0'], ['chore(release): 0.3.0\n\nRelease-Run: 123']), { version: null, base: '0.2.0', decidedBy: [] });
  assert.equal(nextOf(['v0.2.0'], ['fix: x\n\nRelease-Run: major\nSigned-off-by: a <a@b.c>']).version, '0.2.1');
});

test('nextStableVersion: breaking is not major', () => {
  assert.equal(nextOf(['v0.2.0'], ['feat!: drop a setting']).version, '0.3.0');
  assert.equal(nextOf(['v0.2.0'], ['feat(x)!: drop a setting\n\nBREAKING CHANGE: gone']).version, '0.3.0');
  assert.equal(nextOf(['v0.2.0'], ['fix!: drop a setting']).version, '0.2.1');
  assert.equal(nextOf(['v0.2.0'], ['chore!: drop a setting\n\nBREAKING CHANGE: gone']).version, null);
});

test('nextStableVersion: before the first stable the base is 0.0.0', () => {
  assert.equal(nextOf([], ['feat: a']).version, '0.1.0');
  assert.equal(nextOf([], ['feat: a']).base, '0.0.0');
  assert.equal(nextOf([], ['fix: a']).version, '0.0.1');
  assert.equal(nextOf([], ['chore: m\n\nRelease: major']).version, '1.0.0');
});

test('nextStableVersion: a mistyped trailer fails and names the commit', () => {
  const commits = [commit('feat: fine'), commit('chore: milestone\n\nRelease: mayor', false, 'abcdef0123456789')];
  assert.throws(() => nextStableVersion({ tags: ['v0.2.0'], commits }), /abcdef0 "chore: milestone".*"Release: mayor"/);
  assert.throws(() => nextOf(['v0.2.0'], ['chore: m\n\nRelease: ']), /neither "major" nor a version/);
  assert.throws(() => nextOf(['v0.2.0'], ['chore: m\n\nRelease: v1.0']), /neither "major" nor a version/);
});

test('nextStableVersion: several results, the highest wins, and the deciding commits are those that gave it', () => {
  const result = nextOf(['v0.7.2'], ['feat: a', 'fix: b', 'chore: c\n\nRelease: v0.9.0', 'chore: d\n\nRelease: v0.8.0', 'feat: e\n\nRelease: 0.9.0']);
  assert.equal(result.version, '0.9.0');
  assert.deepEqual(result.decidedBy.map(({ subject }) => subject), ['chore: c', 'feat: e']);
  assert.equal(nextOf(['v0.7.2'], ['feat: a', 'chore: c\n\nRelease: major', 'chore: d\n\nRelease: v1.0.0']).version, '1.0.0');
  assert.equal(nextOf(['v0.7.2'], ['fix: a\n\nRelease: v0.7.9']).version, '0.7.9');
  // A trailer below what the commits give does not lower it: the feature is still 0.8.0.
  assert.equal(nextOf(['v0.7.2'], ['feat: a\n\nRelease: v0.7.9']).version, '0.8.0');
});

test('nextStableVersion: a trailer releases even when everything else is a chore', () => {
  assert.equal(nextOf(['v0.2.0'], ['chore: a', 'docs: b\n\nRelease: v0.2.1']).version, '0.2.1');
});

test('nextStableVersion: a merge commit that is not conventional is ignored, trailers included', () => {
  const merge = (message: string) => commit(message, true);
  assert.equal(nextStableVersion({ tags: ['v0.2.0'], commits: [merge('Merge branch develop into main'), commit('fix: a')] }).version, '0.2.1');
  assert.equal(nextStableVersion({ tags: ['v0.2.0'], commits: [merge('Merge pull request #4\n\nRelease: mayor'), commit('chore: a')] }).version, null);
  assert.equal(nextStableVersion({ tags: ['v0.2.0'], commits: [merge('feat: merged feature')] }).version, '0.3.0');
  // The same subject on an ordinary commit still counts.
  assert.equal(nextStableVersion({ tags: ['v0.2.0'], commits: [commit('Merge branch develop')] }).version, null);
});

test('nextStableVersion: pre-release shaped and other tags are not the base', () => {
  const tags = ['v0.1.0', 'v0.2.0-pre', 'v0.9.1-pre', 'v1.0.0-rc.1', 'vNext', 'v0.1.1'];
  assert.equal(nextOf(tags, ['fix: a']).base, '0.1.1');
  assert.equal(nextOf(tags, ['fix: a']).version, '0.1.2');
  assert.equal(nextOf(['v0.9.0', 'v0.10.0'], ['fix: a']).version, '0.10.1');
});

test('nextStableVersion: an explicit version equal to the base fails', () => {
  assert.throws(() => nextOf(['v0.7.2'], ['chore: m\n\nRelease: v0.7.2']), /not above the stable release 0\.7\.2/);
  assert.throws(() => nextOf([], ['chore: m\n\nRelease: 0.0.0']), /not above 0\.0\.0/);
});

test('nextStableVersion: CRLF messages and a trailer only after the subject', () => {
  assert.equal(nextOf(['v0.7.2'], ['chore: m\r\n\r\nBody\r\n\r\nRelease: major\r\n']).version, '1.0.0');
  assert.equal(nextOf(['v0.7.2'], ['Release: major']).version, null);
  assert.equal(nextOf(['v0.7.2'], ['chore: a\n\nThe Release: mayor line inside a sentence']).version, null);
});

test('nextStableVersion: Release is read only in the footer, the last paragraph made of trailers', () => {
  const fence = '```\nRelease: major\n```';
  assert.equal(nextOf(['v0.7.2'], [`docs: explain it\n\nExample:\n\n${fence}`]).version, null);
  assert.equal(nextOf(['v0.7.2'], [`docs: explain it\n\n${fence}\n\nMore text.`]).version, null);
  assert.equal(nextOf(['v0.7.2'], ['docs: explain it\n\nExample:\n\nRelease: mayor\n\nMore text.']).version, null);
  assert.equal(nextOf(['v0.7.2'], ['docs: explain it\n\nRelease: mayor\nand some prose\n\nMore text.']).version, null);
  assert.equal(nextOf(['v0.7.2'], ['chore: m\n\nBody.\n\nSigned-off-by: A <a@b.c>\nRelease: major']).version, '1.0.0');
  assert.equal(nextOf(['v0.7.2'], ['chore: m\n\nRelease: v0.9.0\nRefs #12\nCo-authored-by: A <a@b.c>\n  and more']).version, '0.9.0');
  assert.equal(nextOf(['v0.7.2'], ['chore: m\n\nSome prose.\nRelease: major']).version, null);
  assert.equal(nextOf(['v0.7.2'], ['chore: m\n\nRelease: major\nSome prose.']).version, null);
  assert.equal(nextOf(['v0.7.2'], ['chore: m\nRelease: major']).version, null);
});

test('nextStableVersion: an explicit version has real dots', () => {
  assert.throws(() => nextOf(['v0.7.2'], ['chore: m\n\nRelease: v1x0x0']), /neither "major" nor a version/);
  assert.throws(() => nextOf(['v0.7.2'], ['chore: m\n\nRelease: 1-0-0']), /neither "major" nor a version/);
  assert.throws(() => nextOf(['v0.7.2'], ['chore: m\n\nRelease: 01.0.0']), /neither "major" nor a version/);
});

test('nextStableVersion: types are matched in any case', () => {
  assert.equal(nextOf(['v0.2.0'], ['FEAT: x']).version, '0.3.0');
  assert.equal(nextOf(['v0.2.0'], ['Fix(scope): y']).version, '0.2.1');
  assert.equal(nextStableVersion({ tags: ['v0.2.0'], commits: [commit('Feat: merged', true)] }).version, '0.3.0');
  assert.equal(nextOf(['v0.2.0'], ['CHORE: z']).version, null);
});
