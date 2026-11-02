import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinProblems } from './release-rules.mjs';
import { changelogProblems, checkPackageContents, RUNTIME_DIRECTORIES } from './vsix-contents.mjs';
import { readArchive, vsixInfo } from './vsix-info.mjs';

const args = process.argv.slice(2);
const vsixPath = args[0];
const compareIndex = args.indexOf('--compare');
const comparisonPath = compareIndex >= 0 ? args[compareIndex + 1] : undefined;
// --channel also checks what the registries will read from the file (spec:release#r-r8, r-r9).
const channelIndex = args.indexOf('--channel');
const channel = channelIndex >= 0 ? args[channelIndex + 1] : undefined;

if (!vsixPath) {
  throw new Error(
    'Usage: node scripts/verify-vsix.mjs <file.vsix> [--compare <file.vsix>] [--channel pre-release|stable]',
  );
}
if (channelIndex >= 0 && channel !== 'pre-release' && channel !== 'stable') {
  throw new Error('Use --channel pre-release or --channel stable');
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

const archive = readArchive(path.resolve(vsixPath));
const problems = checkPackageContents({
  listed: readJson('runtime-files.json').files,
  manifest: readJson('package.json'),
  onDisk: RUNTIME_DIRECTORIES.flatMap(filesUnder),
  packaged: [...archive.keys()],
});
const info = vsixInfo(archive);
if (channel) {
  const wanted = readJson('package.json').version;
  if (info.version !== wanted) {
    problems.push(`The VSIX is version ${info.version}, the manifest says ${wanted}`);
  }
  if (info.buildInfoVersion !== info.version) {
    problems.push(`build-info.json says ${info.buildInfoVersion}, the VSIX is ${info.version}`);
  }
  if (info.preRelease !== (channel === 'pre-release')) {
    problems.push(
      `The VSIX is ${info.preRelease ? '' : 'not '}flagged as a pre-release, but this is the ${channel} channel`,
    );
  }
  problems.push(...pinProblems(info.manifest, { stable: channel === 'stable' }));
  // The listing shows the notes of this version (spec:release#r-r10).
  problems.push(...changelogProblems(archive, info.version));
}
if (problems.length > 0) {
  throw new Error(`Package verification failed:\n  ${problems.join('\n  ')}`);
}

const buildInfo = { version: info.buildInfoVersion, commit: info.commit };
if (process.env.EXPECTED_COMMIT && buildInfo.commit !== process.env.EXPECTED_COMMIT) {
  throw new Error(
    `VSIX records commit ${buildInfo.commit}, expected ${process.env.EXPECTED_COMMIT}`,
  );
}

if (comparisonPath) {
  const comparison = readArchive(path.resolve(comparisonPath));
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
