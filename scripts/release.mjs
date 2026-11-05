// The release checks, the CI stamp and the release preparation, as commands the workflows and maintainers call
// (spec:release#r-r8, r-r9, r-r10, r-r11).
//
//   node scripts/release.mjs check --channel pre-release|stable [--tag vX.Y.Z] [--run-number N] [--git-tags]
//   node scripts/release.mjs stamp --run-number N
//   node scripts/release.mjs prepare <version>
//   node scripts/release.mjs notes --channel development|pre-release|stable
//   node scripts/release.mjs info <file.vsix>
//   node scripts/release.mjs plan [--json]
//   node scripts/release.mjs check-next-notes
//
// `check` prints every problem and exits 1; `--run-number` also checks the version the stamp will give, and
// `--git-tags` the tags of the repository. `stamp` sets the patch of the version in this checkout and commits
// nothing. `notes` prints the text of the GitHub release, from the notes file of the channel. `prepare`, on main, sets the
// manifest version, and the extension's entry of package-lock.json, and turns `release-notes/next.md` into
// `release-notes.v<version>.md`, leaving an empty `next.md`; it commits nothing. `info` prints what a VSIX says about
// itself as JSON. `plan` computes the next stable version from the conventional commits since the highest stable tag
// (spec:release#r-r14): it prints the base, the version or "nothing to release" and the commits that decided it, or one
// JSON object with `--json`; it needs the full history and the tags, so it fails on a shallow clone (use fetch-depth 0); it exits 0 when there is nothing to release, and 1 with `error: ...` when the commits are invalid.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatVersion, latestStable, nextNotesProblems, nextStableVersion, prepareProblems, releaseNotesFile, releaseNotesText, releaseProblems, setLockVersion, setVersion, stampVersion, NEXT_NOTES } from './release-rules.mjs';
import { notesDirectory, readNotes } from './release-notes.mjs';
import { linkedSiblings } from './siblings.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = projectDir;
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

/** The commits reachable from HEAD and not from the base tag (all of HEAD before the first stable), with whole messages. */
function gitCommits(baseTag) {
  const range = baseTag ? [`${baseTag}..HEAD`] : ['HEAD'];
  // Records end in NUL; inside one, sha, parents and message are separated by 0x1f, so any message text is safe.
  const result = spawnSync('git', ['log', '-z', '--format=%H%x1f%P%x1f%B', ...range], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git log failed: ${result.stderr || result.error?.message}`);
  return result.stdout
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const text = record.replace(/^\n/, '');
      // Only the first two separators count: the message is kept whole.
      const first = text.indexOf('\x1f');
      const second = text.indexOf('\x1f', first + 1);
      const parents = text.slice(first + 1, second);
      return { sha: text.slice(0, first), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, message: text.slice(second + 1) };
    });
}

function plan() {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (shallow.status === 0 && shallow.stdout.trim() === 'true') {
    throw new Error('plan needs the full history and tags: check out with fetch-depth 0');
  }
  const tags = gitTags();
  const stable = latestStable(tags);
  const result = nextStableVersion({ tags, commits: gitCommits(stable ? `v${formatVersion(stable)}` : undefined) });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Base: ${result.base}${stable ? '' : ' (no stable release yet)'}`);
  console.log(result.version ? `Next version: ${result.version}` : 'Nothing to release.');
  for (const { sha, subject, effect } of result.decidedBy) console.log(`  ${sha.slice(0, 7)} [${effect}] ${subject}`);
}

/** spec:release#r-r15. `release-notes/next.md` is a note a release can use: it exists, has content and is not a draft. */
function checkNextNotes() {
  const problems = nextNotesProblems(readNotes(projectDir).next);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }
  console.log('release-notes/next.md has content and is not a draft.');
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

function notes() {
  const channel = option('--channel');
  if (!['development', 'pre-release', 'stable'].includes(channel)) throw new Error('Use --channel development, pre-release or stable');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const files = readNotes(projectDir);
  process.stdout.write(
    releaseNotesText({
      channel,
      notes: { next: files.next, release: files.releases.find(({ version }) => version === manifest.version)?.text },
    }),
  );
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
  const lockFile = path.join(repositoryRoot, 'package-lock.json');
  // Both texts first, so a failure leaves nothing half done.
  const manifestText = setVersion(fs.readFileSync(manifestFile, 'utf8'), version);
  const lockText = setLockVersion(fs.readFileSync(lockFile, 'utf8'), version);
  fs.writeFileSync(manifestFile, manifestText);
  fs.writeFileSync(lockFile, lockText);
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
  const commands = { check, stamp, prepare, notes, info, plan, 'check-next-notes': checkNextNotes };
  if (!commands[command]) throw new Error('Usage: node scripts/release.mjs check|stamp|prepare|notes|info|plan|check-next-notes ...');
  await commands[command]();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
