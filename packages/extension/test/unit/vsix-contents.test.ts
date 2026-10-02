import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// @ts-expect-error: a plain ES module script without type declarations.
import { checkPackageContents, manifestReferences } from '../../scripts/vsix-contents.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const listed: string[] = JSON.parse(
  readFileSync(new URL('../../runtime-files.json', import.meta.url), 'utf8'),
).files;
/** What a build produces for each entry: a hashed asset name for a pattern, the name itself otherwise. */
const built = listed.map((file) => file.replace('*', 'Ab12_-x9'));
const packaged = [
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  ...built.map((file) => `extension/${file}`),
];

test('the ZenWave task definition registers the command as terminal identity', () => {
  const taskDefinition = manifest.contributes?.taskDefinitions?.find(
    (definition: { type?: string }) => definition.type === 'zenwave-sdk',
  );
  assert.equal(taskDefinition?.properties?.command?.type, 'string');
});

test('the committed list covers everything package.json refers to', () => {
  const listedSet = new Set(listed);
  assert.deepEqual(
    (manifestReferences(manifest) as string[]).filter((file) => !listedSet.has(file)),
    [],
  );
});

test('a complete package passes', () => {
  assert.deepEqual(checkPackageContents({ listed, manifest, onDisk: built, packaged }), []);
});

test('an asset removed from the build fails the release', () => {
  const removed = 'resources/sdk-plugin-catalogue.json';
  const problems: string[] = checkPackageContents({
    listed,
    manifest,
    onDisk: built.filter((file) => file !== removed),
    packaged: packaged.filter((file) => file !== `extension/${removed}`),
  });
  assert.deepEqual(problems, [`VSIX is missing required runtime file: extension/${removed}`]);
});

test('hashed webview assets are listed by pattern: any build of them passes, their absence fails', () => {
  assert.ok(listed.includes('dist/eventflow-webview/assets/index-*.js') && listed.includes('dist/eventflow-webview/assets/index-*.css'));
  const rebuilt = built.map((file) => file.replace('Ab12_-x9', 'Zz99'));
  assert.deepEqual(checkPackageContents({ listed, manifest, onDisk: rebuilt, packaged: rebuilt.map((file) => `extension/${file}`).concat(packaged.slice(0, 4)) }), []);
  const withoutScript = packaged.filter((file) => !/eventflow-webview\/assets\/index-.*\.js$/.test(file));
  assert.deepEqual(checkPackageContents({ listed, manifest, onDisk: built, packaged: withoutScript }),
    ['VSIX is missing required runtime file: extension/dist/eventflow-webview/assets/index-*.js']);
  const stray = 'dist/eventflow-webview/assets/sub/index-x.js';
  assert.deepEqual(checkPackageContents({ listed, manifest, onDisk: [...built, stray], packaged }),
    [`${stray} is a runtime file that runtime-files.json does not list`]);
  assert.throws(() => checkPackageContents({ listed: ['dist/*/x.js'], manifest: {}, onDisk: [], packaged: [] }), /only in the file name/);
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
    onDisk: built,
    packaged: [...packaged, 'extension/src/activate.ts', 'extension/runtime-files.json'],
  });
  assert.equal(problems.length, 2);
});
