import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error The installed YAML parser has no type declarations.
import { load } from 'js-yaml';

// The tools that publish a verified VSIX are installed from this lock in the publish job, where a registry token is in
// the next steps' environment (spec:release#r-r13). A range or an unhashed entry would make that install float.
const directory = join(import.meta.dirname, '../../publish-tools');
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));

test('R-R13 the publishing tools are pinned exactly, in their own package, outside the root install', () => {
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, { '@vscode/vsce': '4.1.0', ovsx: '1.3.0' });
  assert.equal(manifest.devDependencies, undefined);
  const root = JSON.parse(readFileSync(join(directory, '../package.json'), 'utf8'));
  assert.equal(root.workspaces, undefined, 'a workspace pattern that reaches publish-tools would put it in the root install');
});

test('R-R13 the lock of the publishing tools names the pinned versions and a hash for every package', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(lock.packages['node_modules/@vscode/vsce'].version, '4.1.0');
  assert.equal(lock.packages['node_modules/ovsx'].version, '1.3.0');
  const unlocked = Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; link?: boolean }>)
    .filter(([path]) => path !== '')
    .filter(([, entry]) => entry.link || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/'))
    .map(([path]) => path);
  assert.deepEqual(unlocked, []);
});

// The publish jobs must take the tools from the commit. verify runs third-party build code before it uploads, so
// anything it uploads can have been chosen by that code.
const workflows = join(import.meta.dirname, '../../.github/workflows');
const read = (name: string) => readFileSync(join(workflows, name), 'utf8').replace(/\r\n/g, '\n');

test('R-R13 verify does not upload the publishing tools', () => {
  assert.ok(!read('verify.yml').includes('publish-tools'));
});

for (const name of ['pre-release.yml', 'release.yml']) {
  test(`R-R13 ${name} installs the publishing tools from a sparse checkout of the commit, not from the artifact`, () => {
    const text = read(name);
    const publish = text.slice(text.indexOf('\n  publish:'), text.indexOf('\n  trace:') === -1 ? undefined : text.indexOf('\n  trace:'));
    assert.match(publish, /uses: actions\/checkout@[0-9a-f]{40}/);
    assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(publish, /sparse-checkout: publish-tools\n/);
    assert.match(publish, /persist-credentials: false/);
    assert.match(publish, /working-directory: publish-tools\n\s+run: \|\n\s+set -euo pipefail\n\s+npm ci --ignore-scripts/);
    assert.ok(!/artifacts\/publish-tools|SHA256SUMS.*publish-tools/.test(publish));
    assert.ok(publish.indexOf('actions/checkout@') < publish.indexOf('secrets.'), 'the checkout comes before any step that reads a secret');
  });

  test(`R-R13 ${name} installs publishing tools once, only in publish-tools`, () => {
    const document = load(read(name)) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
    const steps = document.jobs?.publish?.steps ?? [];
    assert.ok(steps.length > 0, `${name} has a publish job`);
    assert.deepEqual(npmInstallDirectories(steps), ['publish-tools']);
  });
}

type WorkflowStep = { 'working-directory'?: string; run?: string };

function shellCommands(script: string): string[] {
  return script.split('\n').flatMap((line) => {
    const code = line.replace(/#.*/, '').trim();
    if (!code) return [];
    return code.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  });
}

/** Directory of each `npm ci` or `npm install`, after `cd` and `--prefix`. */
function npmInstallDirectories(steps: WorkflowStep[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    if (typeof step.run !== 'string') continue;
    let directory = step['working-directory'] ?? '.';
    for (const command of shellCommands(step.run)) {
      const cd = /^(?:cd|pushd)\s+(\S+)/.exec(command);
      if (cd) {
        directory = cd[1];
        continue;
      }
      const install = npmInstallDirectory(command, directory);
      if (install !== undefined) found.push(install);
    }
  }
  return found;
}

function npmInstallDirectory(command: string, current: string): string | undefined {
  const tokens = command.split(/\s+/);
  if (tokens[0] !== 'npm') return undefined;
  let prefix: string | undefined;
  let subcommand: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--prefix') {
      prefix = tokens[index + 1];
      index++;
      continue;
    }
    if (token.startsWith('--prefix=')) {
      prefix = token.slice('--prefix='.length);
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!subcommand) subcommand = token;
  }
  if (subcommand !== 'ci' && subcommand !== 'install') return undefined;
  return prefix ?? current;
}
