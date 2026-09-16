import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// @ts-expect-error: a plain ES module script without type declarations.
import { checkPackageContents, manifestReferences } from '../../scripts/vsix-contents.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const listed: string[] = JSON.parse(
  readFileSync(new URL('../../runtime-files.json', import.meta.url), 'utf8'),
).files;
const packaged = [
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  ...listed.map((file) => `extension/${file}`),
];

test('the committed list covers everything package.json refers to', () => {
  const listedSet = new Set(listed);
  assert.deepEqual(
    (manifestReferences(manifest) as string[]).filter((file) => !listedSet.has(file)),
    [],
  );
});

test('a complete package passes', () => {
  assert.deepEqual(checkPackageContents({ listed, manifest, onDisk: listed, packaged }), []);
});

test('an asset removed from the build fails the release', () => {
  const removed = 'resources/sdk-plugin-catalogue.json';
  const problems: string[] = checkPackageContents({
    listed,
    manifest,
    onDisk: listed.filter((file) => file !== removed),
    packaged: packaged.filter((file) => file !== `extension/${removed}`),
  });
  assert.deepEqual(problems, [`VSIX is missing required runtime file: extension/${removed}`]);
});

test('a new runtime asset that is not listed fails the release', () => {
  const added = 'dist/eventflow/renderer.js';
  const problems: string[] = checkPackageContents({
    listed,
    manifest,
    onDisk: [...listed, added, 'dist/node/extension.js.map'],
    packaged: [...packaged, `extension/${added}`],
  });
  assert.deepEqual(problems, [`${added} is a runtime file that runtime-files.json does not list`]);
});

test('development files in the package fail the release', () => {
  const problems: string[] = checkPackageContents({
    listed,
    manifest,
    onDisk: listed,
    packaged: [...packaged, 'extension/src/activate.ts', 'extension/runtime-files.json'],
  });
  assert.equal(problems.length, 2);
});
