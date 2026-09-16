import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageContents, RUNTIME_DIRECTORIES } from './vsix-contents.mjs';

const args = process.argv.slice(2);
const vsixPath = args[0];
const compareIndex = args.indexOf('--compare');
const comparisonPath = compareIndex >= 0 ? args[compareIndex + 1] : undefined;

if (!vsixPath) {
  throw new Error('Usage: node scripts/verify-vsix.mjs <file.vsix> [--compare <file.vsix>]');
}

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(extensionRoot, file), 'utf8'));

function filesUnder(directory) {
  const absoluteDirectory = path.join(extensionRoot, directory);
  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(relative) : [relative];
  });
}

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
const problems = checkPackageContents({
  listed: readJson('runtime-files.json').files,
  manifest: readJson('package.json'),
  onDisk: RUNTIME_DIRECTORIES.flatMap(filesUnder),
  packaged: [...archive.keys()],
});
if (problems.length > 0) {
  throw new Error(`Package verification failed:\n  ${problems.join('\n  ')}`);
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
