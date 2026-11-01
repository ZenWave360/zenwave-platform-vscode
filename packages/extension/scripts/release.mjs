// The release checks, the CI stamp and the release preparation, as commands the workflows and maintainers call
// (spec:release#r-r8, r-r9, r-r10, r-r11).
//
//   node scripts/release.mjs check --channel pre-release|stable [--tag vX.Y.Z] [--run-number N] [--git-tags]
//   node scripts/release.mjs stamp --run-number N
//   node scripts/release.mjs prepare <version>
//   node scripts/release.mjs info <file.vsix>
//
// `check` prints every problem and exits 1; `--run-number` also checks the version the stamp will give, and
// `--git-tags` the tags of the repository. `stamp` sets the patch of the version in this checkout and commits
// nothing. `prepare`, on main, sets the manifest version and turns `release-notes/next.md` into
// `release-notes.v<version>.md`, leaving an empty `next.md`; it commits nothing. `info` prints what a VSIX says about
// itself as JSON.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProblems, releaseNotesFile, releaseProblems, setVersion, stampVersion, NEXT_NOTES } from './release-rules.mjs';
import { notesDirectory, readNotes } from './release-notes.mjs';
import { linkedSiblings } from './siblings.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(projectDir, '../..');
const manifestFile = path.join(projectDir, 'package.json');

const [command, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
};

function gitTags() {
  const result = spawnSync('git', ['tag', '--list', 'v*'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git tag --list failed: ${result.stderr || result.error?.message}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function check() {
  const channel = option('--channel');
  if (channel !== 'pre-release' && channel !== 'stable') throw new Error('Use --channel pre-release or --channel stable');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const runNumber = option('--run-number');
  const notes = readNotes(projectDir);
  const problems = releaseProblems({
    channel,
    manifest,
    lock: JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')),
    tag: option('--tag'),
    linked: linkedSiblings().map((sibling) => sibling.package),
    tags: args.includes('--git-tags') ? gitTags() : undefined,
    runNumber: runNumber === undefined ? undefined : Number(runNumber),
    notes: { next: notes.next, release: notes.releases.find(({ version }) => version === manifest.version)?.text },
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }
  console.log(`The ${channel} checks pass for ${manifest.version}.`);
}

function stamp() {
  const manifest = stampVersion(fs.readFileSync(manifestFile, 'utf8'), Number(option('--run-number')));
  fs.writeFileSync(manifestFile, manifest.text);
  console.log(manifest.version);
}

function prepare() {
  const version = args[0];
  if (!version) throw new Error('Usage: node scripts/release.mjs prepare <version>');
  const directory = notesDirectory(projectDir);
  const next = path.join(directory, NEXT_NOTES);
  const target = path.join(directory, releaseNotesFile(version));
  const problems = prepareProblems(version, gitTags(), { targetExists: fs.existsSync(target), nextExists: fs.existsSync(next) });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }
  fs.writeFileSync(manifestFile, setVersion(fs.readFileSync(manifestFile, 'utf8'), version));
  fs.renameSync(next, target);
  fs.writeFileSync(next, '');
  console.log(`Set ${version}, and moved the notes to release-notes/${releaseNotesFile(version)}. Review them, then commit and tag v${version} on main.`);
}

async function info() {
  // Loaded here: check and stamp run before npm ci, and the archive reader is a dependency.
  const { readArchive, vsixInfo } = await import('./vsix-info.mjs');
  const file = args[0];
  if (!file) throw new Error('Usage: node scripts/release.mjs info <file.vsix>');
  const { manifest, ...rest } = vsixInfo(readArchive(path.resolve(file)));
  console.log(JSON.stringify(rest, null, 2));
}

try {
  const commands = { check, stamp, prepare, info };
  if (!commands[command]) throw new Error('Usage: node scripts/release.mjs check|stamp|prepare|info ...');
  await commands[command]();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
