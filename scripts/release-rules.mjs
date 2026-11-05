/**
 * What makes a build releasable, as pure functions: spec:release#r-r8 (channel and stamped version),
 * spec:release#r-r9 (exact `@zenwave360/*` pins), spec:release#r-r10 (release notes, the generated
 * changelog) and spec:release#r-r11 (stable tag and notes). One source of truth: `package.mjs` and `release.mjs` both call
 * `releaseProblems`, and the workflows call `release.mjs`.
 */

export const ZENWAVE_SCOPE = '@zenwave360/';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'];
/** One number of a version: no leading zero, which the Marketplace refuses (decision 0024). */
const NUMBER = '(0|[1-9]\\d*)';
/** A pin that names one build: no range, no tag, no `latest`. A suffix makes it a pre-release of the package. */
const EXACT_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$`);
/** The tag of a stable release. A `-pre` tag, or anything else, matches nothing. */
export const STABLE_TAG = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const EXTENSION_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

/** The manifest blocks that repeat a pinned package's version for the build. */
export const PIN_BLOCKS = ['zenwaveLanguageServer', 'zenwaveEventFlowWebview'];

export function parseExtensionVersion(version) {
  const match = EXTENSION_VERSION.exec(version ?? '');
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

export const isExactVersion = (version) => typeof version === 'string' && EXACT_VERSION.test(version);
export const isStableVersion = (version) => isExactVersion(version) && !EXACT_VERSION.exec(version)[4];

/** Every `@zenwave360/*` the extension depends on, with where it is declared. */
export function zenwaveDependencies(manifest) {
  return DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => name.startsWith(ZENWAVE_SCOPE))
      .map(([name, version]) => ({ name, version, section })),
  );
}

/** The version each `@zenwave360/*` package is pinned to, from the manifest. */
export function pinnedVersions(manifest) {
  return Object.fromEntries(zenwaveDependencies(manifest).map(({ name, version }) => [name, version]));
}

/**
 * spec:release#r-r9. `lock` is the parsed package-lock.json, or undefined to skip it. `stable` also refuses a pin
 * with a suffix (`next`), which is what a stable release needs (spec:release#r-r11).
 */
export function pinProblems(manifest, { lock, stable = false } = {}) {
  const problems = [];
  const dependencies = zenwaveDependencies(manifest);
  for (const { name, version, section } of dependencies) {
    if (!isExactVersion(version)) {
      problems.push(`${name} is "${version}" in ${section}: pin an exact version, not a range or a tag`);
    } else if (stable && !isStableVersion(version)) {
      problems.push(`${name} is ${version} in ${section}: a stable release needs a stable version`);
    }
  }
  const declared = new Map(dependencies.map(({ name, version }) => [name, version]));
  for (const key of PIN_BLOCKS) {
    const block = manifest[key];
    if (!block) continue;
    const dependency = declared.get(block.package);
    if (dependency === undefined) {
      problems.push(`${key} names ${block.package}, which is not a dependency`);
    } else if (block.version !== dependency) {
      problems.push(`${block.package} is ${dependency} in package.json but ${block.version} in ${key}`);
    }
  }
  if (lock) {
    for (const [name, version] of declared) {
      const entry = lock.packages?.[`node_modules/${name}`];
      if (!entry) {
        problems.push(`${name} is not in package-lock.json: run npm install`);
      } else if (entry.link || entry.version !== version) {
        problems.push(`${name} is ${version} in package.json but ${entry.link ? 'a link' : entry.version} in package-lock.json`);
      }
    }
  }
  return problems;
}

/** The files of `release-notes/`: `next.md` for what is on develop, one `release-notes.vX.Y.Z.md` per stable release. */
export const NEXT_NOTES = 'next.md';
export const RELEASE_NOTES_FILE = new RegExp(`^release-notes\\.v${NUMBER}\\.${NUMBER}\\.${NUMBER}\\.md$`);
export const releaseNotesFile = (version) => `release-notes.v${version}.md`;

export const formatVersion = ({ major, minor, patch }) => `${major}.${minor}.${patch}`;
/** Semantic order, so 0.10.0 is above 0.9.0; a string or file name compare would put it below. */
export const compareVersions = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** spec:release#r-r8. The highest stable release among the tags `vX.Y.Z`, any minor. A `-pre` tag and any other tag are ignored. */
export function latestStable(tags) {
  return tags
    .map((tag) => STABLE_TAG.exec(tag))
    .filter(Boolean)
    .map(([, major, minor, patch]) => ({ major: Number(major), minor: Number(minor), patch: Number(patch) }))
    .sort(compareVersions)
    .at(-1);
}

/**
 * spec:release#r-r8. A pre-release is the manifest's major.minor and the run number, as the Marketplace takes no suffix
 * and no leading zero. Without `tags` nothing is checked against them; without `runNumber` the stamped version is not.
 */
export function preReleaseVersionProblems(version, tags, runNumber) {
  const current = parseExtensionVersion(version);
  if (!current) return [`The manifest version "${version}" is not major.minor.patch`];
  if (!tags) return [];
  const stable = latestStable(tags);
  const expected = stable ? `${stable.major}.${stable.minor}` : '0.0';
  const problems = [];
  if (`${current.major}.${current.minor}` !== expected) {
    problems.push(
      `The manifest says ${version}, but pre-releases take the major.minor of the last stable release, ` +
        `${expected}${stable ? ` (v${formatVersion(stable)})` : ', as there is none yet'}: merge main back into develop`,
    );
  }
  // Only when the manifest already has the stable release's major.minor; otherwise "merge main back" above is the remedy.
  if (stable && runNumber !== undefined && `${current.major}.${current.minor}` === `${stable.major}.${stable.minor}` && runNumber <= stable.patch) {
    problems.push(
      `The pre-release ${current.major}.${current.minor}.${runNumber} is not above the stable release ${formatVersion(stable)}, ` +
        `so users on the pre-release channel would be moved back. A hotfix takes a low patch, such as v${current.major}.${current.minor}.1, ` +
        `never one above the run numbers; the pipeline fails until a run number is above ${stable.patch}, or the minor is raised`,
    );
  }
  return problems;
}

/** spec:release#r-r10, r-r11. `notes.next` and `notes.release` are the text of the files, undefined when a file is absent. */
export function notesProblems({ channel, version, notes = {} }) {
  if (channel === 'pre-release') {
    return notes.next === undefined ? [`release-notes/${NEXT_NOTES} is missing; it may be empty`] : [];
  }
  if (channel !== 'stable') return [];
  const file = `release-notes/${releaseNotesFile(version)}`;
  if (notes.release === undefined) return [`${file} is missing: run "npm run release:prepare -- ${version}" on main`];
  return noteContentProblems(file, notes.release);
}

/**
 * spec:release#r-r15. The notes check of the plan job: `release-notes/next.md`, which `prepare` will turn into the
 * release's notes, must exist and pass the content rules of r-r11, so a bad note fails before anything is changed.
 */
export function nextNotesProblems(text) {
  const file = `release-notes/${NEXT_NOTES}`;
  return text === undefined ? [`${file} is missing`] : noteContentProblems(file, text);
}

function noteContentProblems(file, text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.some((line) => !HEADING.test(line))) return [`${file} is empty: it needs a line that is not a heading`];
  // Only the first heading and the first line that is not a heading say whether the file is a draft; a later line may use the word.
  const marked = [lines.find((line) => HEADING.test(line)), lines.find((line) => !HEADING.test(line))].find((line) => line !== undefined && DRAFT.test(line));
  if (marked !== undefined) return [`${file} is marked as a draft: "${marked.trim()}"`];
  return [];
}

/** An ATX heading: one to six `#` and a space. */
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
/** The word `draft` in any case; "overdraft" does not count. */
const DRAFT = /\bdraft\b/i;

/**
 * spec:release#r-r10. The text of the GitHub release: the channel's notes file as written, not the generated changelog,
 * so a line that looks like a changelog heading comes through. Empty for a development build or a blank file.
 */
export function releaseNotesText({ channel, notes = {} }) {
  const text = channel === 'pre-release' ? notes.next : channel === 'stable' ? notes.release : undefined;
  const body = (text ?? '').replace(/\r\n/g, '\n').trim();
  return body ? `${body}\n` : '';
}

/** spec:release#r-r11. What stops `prepare` from setting `version` on main. */
export function prepareProblems(version, tags, { targetExists = false, nextExists = true } = {}) {
  const wanted = parseExtensionVersion(version);
  if (!wanted) return [`"${version}" is not major.minor.patch`];
  const problems = [];
  const stable = latestStable(tags);
  if (stable && compareVersions(wanted, stable) <= 0) {
    problems.push(`${version} is not above the stable release ${formatVersion(stable)}`);
  }
  if (targetExists) problems.push(`release-notes/${releaseNotesFile(version)} already exists`);
  if (!nextExists) problems.push(`release-notes/${NEXT_NOTES} is missing`);
  return problems;
}

/**
 * All the problems with building `channel` from this checkout. Empty means releasable. Inputs are plain data so the
 * rules can be tested; `release.mjs` and `package.mjs` read the real ones.
 *
 * - `tag`: the release tag, for the stable channel.
 * - `linked`: sibling builds linked into node_modules, which neither channel may ship.
 * - `tags`: the repository's tags; without them the rules that need them are skipped.
 * - `runNumber`: the pre-release's run number, to check the stamped version against the tags.
 * - `notes`: see `notesProblems`.
 */
export function releaseProblems({ channel, manifest, lock, tag, linked = [], tags, runNumber, notes }) {
  const problems = [];
  if (channel === 'stable') {
    const match = tag === undefined ? undefined : STABLE_TAG.exec(tag);
    if (!parseExtensionVersion(manifest.version)) {
      problems.push(`The manifest version "${manifest.version}" is not major.minor.patch`);
    }
    if (tag === undefined || !match) {
      problems.push(`Tag ${tag ?? '(none)'} is not a stable release tag: use vMAJOR.MINOR.PATCH; a -pre tag never publishes`);
    } else if (`${match[1]}.${match[2]}.${match[3]}` !== manifest.version) {
      problems.push(`Tag ${tag} does not match package version ${manifest.version}`);
    }
    const current = parseExtensionVersion(manifest.version);
    const highest = tags && latestStable(tags.filter((name) => name !== `v${manifest.version}`));
    if (current && highest && compareVersions(current, highest) <= 0) {
      problems.push(
        `The stable release ${manifest.version} is not above the stable release ${formatVersion(highest)} (v${formatVersion(highest)}): ` +
          'a stable release must be above every other one, so use a higher version',
      );
    }
    if (tags?.includes(`v${manifest.version}-pre`)) {
      problems.push(
        `The pre-release tag v${manifest.version}-pre exists: a pre-release never becomes a stable release, so use a new version`,
      );
    }
  } else {
    problems.push(...preReleaseVersionProblems(manifest.version, tags, runNumber));
  }
  problems.push(...pinProblems(manifest, { lock, stable: channel === 'stable' }));
  problems.push(...notesProblems({ channel, version: manifest.version, notes }));
  if (linked.length > 0) {
    problems.push(
      `A ${channel} can't ship sibling builds: ${linked.join(', ')}. Run npm ci with ZENWAVE_USE_LOCAL_DEPENDENCIES=false`,
    );
  }
  return problems;
}

/**
 * spec:release#r-r10. CHANGELOG.md from the notes, full content, highest version first. `next` is `{ heading, text }`
 * or undefined (a stable build leaves it out); `releases` are `{ version, text, date }`.
 */
export function buildChangelog({ next, releases }) {
  const ordered = [...releases].sort((a, b) => compareVersions(parseExtensionVersion(b.version), parseExtensionVersion(a.version)));
  const sections = [
    ...(next ? [{ heading: next.heading, text: next.text }] : []),
    ...ordered.map(({ version, date, text }) => ({ heading: `## [${version}] - ${date}`, text })),
  ].map(({ heading, text }) => {
    const body = text.replace(/\r\n/g, '\n').trim();
    return body ? `${heading}\n\n${body}` : heading;
  });
  return `# Changelog\n\n${sections.join('\n\n')}\n`;
}

/** spec:release#r-r8. The workflow's run number replaces the patch. Text in, text out, so the file keeps its line ends. */
export function stampVersion(manifestText, runNumber) {
  if (!Number.isInteger(runNumber) || runNumber < 1) throw new Error(`Run number ${runNumber} is not a positive integer`);
  const pattern = new RegExp(`^(  "version": ")${NUMBER}\\.${NUMBER}\\.\\d+(")`, 'm');
  const match = pattern.exec(manifestText);
  if (!match) throw new Error('package.json has no top-level "version" of the form major.minor.patch');
  return {
    text: manifestText.replace(pattern, `$1$2.$3.${runNumber}$4`),
    version: `${match[2]}.${match[3]}.${runNumber}`,
  };
}

/** spec:release#r-r11. The manifest's version, set whole by `prepare`. Text in, text out. */
export function setVersion(manifestText, version) {
  const pattern = /^(  "version": ")\d+\.\d+\.\d+(")/m;
  if (!pattern.test(manifestText)) throw new Error('package.json has no top-level "version" of the form major.minor.patch');
  return manifestText.replace(pattern, `$1${version}$2`);
}

/** spec:release#r-r11. The same version at the top of the lock and in its root entry, which are both the extension, so the next `npm install` has nothing to rewrite. */
export function setLockVersion(lockText, version) {
  const pattern = /("packages": \{\s*"": \{[^{}]*?"version": ")[^"]*(")/;
  if (!pattern.test(lockText)) throw new Error('package-lock.json has no root package entry with a version');
  return lockText.replace(pattern, `$1${version}$2`).replace(/^(  "version": ")[^"]*(")/m, `$1${version}$2`);
}

/** A conventional subject: `type`, an optional `(scope)`, an optional `!`, then `: `. The `!` has no effect (spec:release#r-r14). */
const CONVENTIONAL_SUBJECT = /^([a-z]+)(?:\([^)]*\))?!?: \S/i;
/** A `Release:` footer line; the value is whatever follows on that line. */
const RELEASE_TRAILER = /^Release:[ \t]*(.*?)[ \t]*$/;
/** A git trailer line, `Token: value` or `Token #value`, and the continuation of one. */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*(?::(?:[ \t]|$)|[ \t]#)/;
const CONTINUATION_LINE = /^[ \t]+\S/;
const EXPLICIT_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The trailer lines of a message: the last paragraph, when it is not the subject's and every line of it is a trailer or
 * the continuation of one. Anything else, a code fence or prose in the last paragraph included, means no trailers.
 */
function footerLines(lines) {
  const paragraphs = [[]];
  for (const line of lines) {
    if (line.trim() === '') {
      if (paragraphs.at(-1).length > 0) paragraphs.push([]);
    } else {
      paragraphs.at(-1).push(line);
    }
  }
  if (paragraphs.at(-1).length === 0) paragraphs.pop();
  if (paragraphs.length < 2) return [];
  const footer = paragraphs.at(-1);
  const shaped = footer.every((line, index) => TRAILER_LINE.test(line) || (index > 0 && CONTINUATION_LINE.test(line)));
  return shaped ? footer : [];
}
const shortSha = (sha) => String(sha).slice(0, 7);

/**
 * spec:release#r-r14. The next stable version, from the tags and the commits since the highest stable tag.
 * `commits` are `{ sha, message, merge? }` with the whole message (subject, body, footers). The base is the highest
 * stable-shaped tag (`STABLE_TAG`), `0.0.0` before the first. A merge commit with a subject that is not conventional is
 * ignored altogether, trailers included. A `Release:` trailer is a line `Release: <value>` in the footer, the last
 * paragraph of the message when it is made only of git trailers, in any commit that is not ignored. Types are matched
 * in any case. Returns `{ version, base, decidedBy }`: `version` is null when nothing is to be released,
 * and `decidedBy` lists the commits that gave the version, each with its `effect`. Throws an Error naming the commit for
 * a trailer that is neither `major` nor a version, or a version not above the base tag.
 */
export function nextStableVersion({ tags, commits }) {
  const baseVersion = latestStable(tags) ?? { major: 0, minor: 0, patch: 0 };
  const base = formatVersion(baseVersion);
  const hasTag = latestStable(tags) !== undefined;
  const bump = {
    major: { effect: 'Release: major', version: { major: baseVersion.major + 1, minor: 0, patch: 0 } },
    minor: { effect: 'feat', version: { major: baseVersion.major, minor: baseVersion.minor + 1, patch: 0 } },
    patch: { effect: 'fix', version: { major: baseVersion.major, minor: baseVersion.minor, patch: baseVersion.patch + 1 } },
  };
  const decisions = [];
  for (const { sha, message, merge = false } of commits) {
    const lines = String(message).split(/\r?\n/);
    const subject = lines[0].trim();
    const type = CONVENTIONAL_SUBJECT.exec(subject)?.[1]?.toLowerCase();
    if (merge && !type) continue;
    const candidates = [];
    for (const line of footerLines(lines)) {
      const value = RELEASE_TRAILER.exec(line)?.[1];
      if (value === undefined) continue;
      const explicit = EXPLICIT_VERSION.exec(value);
      if (value === 'major') {
        candidates.push(bump.major);
      } else if (explicit) {
        const version = { major: Number(explicit[1]), minor: Number(explicit[2]), patch: Number(explicit[3]) };
        if (compareVersions(version, baseVersion) <= 0) {
          throw new Error(
            `Commit ${shortSha(sha)} "${subject}": Release: ${value} is not above ${hasTag ? `the stable release ${base}` : `${base}`}`,
          );
        }
        candidates.push({ effect: `Release: ${formatVersion(version)}`, version });
      } else {
        throw new Error(`Commit ${shortSha(sha)} "${subject}": "Release: ${value}" is neither "major" nor a version X.Y.Z`);
      }
    }
    if (type === 'feat') candidates.push(bump.minor);
    else if (type === 'fix') candidates.push(bump.patch);
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
    decisions.push({ sha, subject, effect: best.effect, version: best.version });
  }
  if (decisions.length === 0) return { version: null, base, decidedBy: [] };
  const winner = decisions.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a)).version;
  return {
    version: formatVersion(winner),
    base,
    decidedBy: decisions
      .filter(({ version }) => compareVersions(version, winner) === 0)
      .map(({ sha, subject, effect }) => ({ sha, subject, effect })),
  };
}
