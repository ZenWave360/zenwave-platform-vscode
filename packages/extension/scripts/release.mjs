// The release checks and the CI stamp, as commands the workflows call (spec:release#r-r8, r-r9, r-r10, r-r11).
//
//   node scripts/release.mjs check --channel pre-release|stable [--tag vX.Y.Z] [--stamped] [--git-tags]
//   node scripts/release.mjs stamp --run-number N [--date YYYY-MM-DD]
//   node scripts/release.mjs info <file.vsix>
//
// `check` prints every problem and exits 1. `stamp` rewrites the version and the changelog heading in this checkout
// and commits nothing. `info` prints what a VSIX says about itself as JSON.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProblems, stampChangelog, stampVersion } from './release-rules.mjs';
import { linkedSiblings } from './siblings.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(projectDir, '../..');
const manifestFile = path.join(projectDir, 'package.json');
const changelogFile = path.join(projectDir, 'CHANGELOG.md');

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
  const stamped = args.includes('--stamped') || channel === 'stable';
  const problems = releaseProblems({
    channel,
    manifest,
    changelog: fs.readFileSync(changelogFile, 'utf8'),
    changelogHeading: stamped ? manifest.version : 'Unreleased',
    lock: JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')),
    tag: option('--tag'),
    linked: linkedSiblings().map((sibling) => sibling.package),
    tags: args.includes('--git-tags') ? gitTags() : undefined,
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }
  console.log(`The ${channel} checks pass for ${manifest.version}.`);
}

function stamp() {
  const runNumber = Number(option('--run-number'));
  const date = option('--date') ?? new Date().toISOString().slice(0, 10);
  const manifest = stampVersion(fs.readFileSync(manifestFile, 'utf8'), runNumber);
  const changelog = stampChangelog(fs.readFileSync(changelogFile, 'utf8'), manifest.version, date);
  fs.writeFileSync(manifestFile, manifest.text);
  fs.writeFileSync(changelogFile, changelog);
  console.log(manifest.version);
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
  const commands = { check, stamp, info };
  if (!commands[command]) throw new Error('Usage: node scripts/release.mjs check|stamp|info ...');
  await commands[command]();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
