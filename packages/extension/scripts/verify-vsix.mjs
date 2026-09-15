import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const vsixPath = args[0];
const compareIndex = args.indexOf('--compare');
const comparisonPath = compareIndex >= 0 ? args[compareIndex + 1] : undefined;

if (!vsixPath) {
  throw new Error('Usage: node scripts/verify-vsix.mjs <file.vsix> [--compare <file.vsix>]');
}

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runtimeFiles(directory) {
  const absoluteDirectory = path.join(extensionRoot, directory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory()
      ? runtimeFiles(relative)
      : [`extension/${relative}`];
  });
}

const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/dist/node/extension.js',
  'extension/dist/browser/extension.js',
  'extension/dist/build-info.json',
  ...runtimeFiles('resources'),
  ...runtimeFiles('syntaxes'),
];

const forbidden = [
  /^extension\/(src|test|tests|fixtures|scripts)\//,
  /^extension\/\.vscode/,
  /^extension\/.*\.(?:ts|tsx|map|tsbuildinfo)$/,
  /^extension\/(?:esbuild\.mjs|tsconfig\.json)$/,
];

function readArchive(file) {
  const zip = new AdmZip(path.resolve(file));
  return new Map(
    zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => [entry.entryName.replaceAll('\\', '/'), entry.getData()]),
  );
}

const archive = readArchive(vsixPath);
for (const file of required) {
  if (!archive.has(file)) {
    throw new Error(`VSIX is missing required runtime file: ${file}`);
  }
}

for (const file of archive.keys()) {
  if (forbidden.some((pattern) => pattern.test(file))) {
    throw new Error(`VSIX contains development-only file: ${file}`);
  }
}

const buildInfo = JSON.parse(archive.get('extension/dist/build-info.json').toString('utf8'));
if (process.env.EXPECTED_COMMIT && buildInfo.commit !== process.env.EXPECTED_COMMIT) {
  throw new Error(
    `VSIX records commit ${buildInfo.commit}, expected ${process.env.EXPECTED_COMMIT}`,
  );
}

if (comparisonPath) {
  const comparison = readArchive(comparisonPath);
  const leftFiles = [...archive.keys()].sort();
  const rightFiles = [...comparison.keys()].sort();
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) {
    throw new Error('Rebuilt VSIX contains a different set of files');
  }
  for (const file of leftFiles) {
    if (!archive.get(file).equals(comparison.get(file))) {
      throw new Error(`Rebuilt VSIX has different content for ${file}`);
    }
  }
}

const size = [...archive.values()].reduce((total, content) => total + content.length, 0);
console.log(
  `Verified ${archive.size} packaged files (${size} uncompressed bytes), build ${buildInfo.version} from ${buildInfo.commit}`,
);
