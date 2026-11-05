// Reading the release notes and generating CHANGELOG.md from them (spec:release#r-r10). The notes are
// `release-notes/next.md` and one `release-notes.vX.Y.Z.md` per stable release; the changelog is never committed, so the
// listing and the files cannot disagree. Used by `package.mjs` on every channel and by `release.mjs`.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildChangelog, NEXT_NOTES, RELEASE_NOTES_FILE } from './release-rules.mjs';

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

export const notesDirectory = (projectDir) => path.join(projectDir, 'release-notes');

/** `next` and each stable release's text; `undefined` where there is no file. */
export function readNotes(projectDir) {
  const directory = notesDirectory(projectDir);
  const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  const releases = files
    .map((name) => ({ name, match: RELEASE_NOTES_FILE.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({ version: `${match[1]}.${match[2]}.${match[3]}`, text: fs.readFileSync(path.join(directory, name), 'utf8') }));
  return { next: read(path.join(directory, NEXT_NOTES)), releases };
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const dayOf = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? '') ? iso.slice(0, 10) : undefined);

/**
 * The day of the commit being built, in its own time zone, not today: building the same commit again gives the same
 * changelog bytes (spec:release#r-r1).
 */
export function commitDate(root, ref = 'HEAD') {
  const date = dayOf(git(root, ['show', '-s', '--format=%cI', ref]));
  if (!date) throw new Error(`The date of ${ref} is unknown: is this a git checkout?`);
  return date;
}

/** The day of the commit a stable release's tag points at, or of HEAD when the tag does not exist (yet). */
export function releaseDate(root, version) {
  return dayOf(git(root, ['show', '-s', '--format=%cI', `refs/tags/v${version}^{commit}`])) ?? commitDate(root);
}

/**
 * Writes `CHANGELOG.md` in `projectDir`. Every stable release's notes are in it. `next.md` is in it unless the channel
 * is stable: under the stamped version and date of the commit for a pre-release, as unreleased otherwise.
 */
export function generateChangelog({ projectDir, repositoryRoot, channel, version }) {
  const notes = readNotes(projectDir);
  const next =
    channel === 'stable' || notes.next === undefined
      ? undefined
      : {
          heading: channel === 'pre-release' ? `## [${version}] - ${commitDate(repositoryRoot)}` : '## [Unreleased]',
          text: notes.next,
        };
  const text = buildChangelog({
    next,
    releases: notes.releases.map((release) => ({ ...release, date: releaseDate(repositoryRoot, release.version) })),
  });
  fs.writeFileSync(path.join(projectDir, 'CHANGELOG.md'), text);
  return text;
}
