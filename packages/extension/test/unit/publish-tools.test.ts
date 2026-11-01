import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The tools that publish a verified VSIX are installed from this lock in the publish job, where a registry token is in
// the next steps' environment (spec:release#r-r13). A range or an unhashed entry would make that install float.
const directory = join(import.meta.dirname, '../../publish-tools');
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));

test('R-R13 the publishing tools are pinned exactly, in their own package outside the workspaces', () => {
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, { '@vscode/vsce': '4.1.0', ovsx: '1.3.0' });
  assert.equal(manifest.devDependencies, undefined);
  const root = JSON.parse(readFileSync(join(directory, '../../../package.json'), 'utf8'));
  assert.deepEqual(root.workspaces, ['packages/*'], 'a workspace pattern that reaches publish-tools would put it in the root install');
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
const workflows = join(import.meta.dirname, '../../../../.github/workflows');
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
    assert.match(publish, /sparse-checkout: packages\/extension\/publish-tools\n/);
    assert.match(publish, /persist-credentials: false/);
    assert.match(publish, /working-directory: packages\/extension\/publish-tools\n\s+run: \|\n\s+set -euo pipefail\n\s+npm ci --ignore-scripts/);
    assert.ok(!/artifacts\/publish-tools|SHA256SUMS.*publish-tools/.test(publish));
    assert.ok(publish.indexOf('actions/checkout@') < publish.indexOf('secrets.'), 'the checkout comes before any step that reads a secret');
  });
}
