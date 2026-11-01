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
