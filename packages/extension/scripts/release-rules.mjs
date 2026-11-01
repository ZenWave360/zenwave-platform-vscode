/**
 * What makes a build releasable, as pure functions: spec:release#r-r8 (channel and stamped version),
 * spec:release#r-r9 (exact `@zenwave360/*` pins), spec:release#r-r10 (changelog stamp) and
 * spec:release#r-r11 (stable tag). One source of truth: `package.mjs` and `release.mjs` both call
 * `releaseProblems`, and the workflows call `release.mjs`.
 */

export const ZENWAVE_SCOPE = '@zenwave360/';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'];
/** A pin that names one build: no range, no tag, no `latest`. A suffix makes it a pre-release of the package. */
const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
/** The tag of a stable release. A `-pre` tag, or anything else, matches nothing. */
export const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const EXTENSION_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

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

/** spec:release#r-r8. Odd minor is pre-release, even is stable, as the Marketplace takes no suffix. */
export function channelProblems(version, channel) {
  const parsed = parseExtensionVersion(version);
  if (!parsed) return [`The manifest version "${version}" is not major.minor.patch`];
  const odd = parsed.minor % 2 === 1;
  if (channel === 'pre-release' && !odd) {
    return [`Version ${version} has an even minor, which is stable: raise the minor to the next odd number on develop`];
  }
  if (channel === 'stable' && odd) {
    return [`Version ${version} has an odd minor, which is pre-release: a stable release needs an even minor`];
  }
  return [];
}

/**
 * The highest stable version among tags `vX.EVEN.Z`. A `-pre` tag, an odd minor (which `release.yml` refuses and the
 * rules call pre-release) and any other tag are ignored; a failed even tag still counts (spec:release#r-r8).
 */
export function latestStable(tags) {
  const versions = tags
    .map((tag) => STABLE_TAG.exec(tag))
    .filter((match) => match && Number(match[2]) % 2 === 0)
    .map(([, major, minor, patch]) => ({ major: Number(major), minor: Number(minor), patch: Number(patch) }));
  return versions.sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch).at(-1);
}

/** spec:release#r-r8. `develop` always sits above the latest stable release: compared on major.minor. */
export function aboveStableProblems(version, tags) {
  const current = parseExtensionVersion(version);
  const stable = latestStable(tags);
  if (!current || !stable) return [];
  if (current.major < stable.major || (current.major === stable.major && current.minor <= stable.minor)) {
    return [
      `Version ${version} is not above the stable release ${stable.major}.${stable.minor}.${stable.patch}: ` +
        `raise the minor on develop to ${stable.major}.${stable.minor + (stable.minor % 2 === 0 ? 1 : 2)}.0, or users on the pre-release channel are moved back`,
    ];
  }
  return [];
}

export const changelogHasSection = (changelog, heading) =>
  new RegExp(`^## \\[${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(changelog);

/**
 * All the problems with building `channel` from this checkout. Empty means releasable. Inputs are plain data so the
 * rules can be tested; `release.mjs` and `package.mjs` read the real ones.
 *
 * - `changelogHeading`: the section that must exist, `Unreleased` before the stamp, the version after it.
 * - `tag`: the release tag, for the stable channel.
 * - `linked`: sibling builds linked into node_modules, which neither channel may ship.
 * - `tags`: the repository's tags, to keep a pre-release above stable.
 */
export function releaseProblems({ channel, manifest, changelog, changelogHeading, lock, tag, linked = [], tags }) {
  const problems = [...channelProblems(manifest.version, channel)];
  if (channel === 'stable') {
    const match = tag === undefined ? undefined : STABLE_TAG.exec(tag);
    if (tag === undefined || !match) {
      problems.push(
        `Tag ${tag ?? '(none)'} is not a stable release tag: use vMAJOR.EVEN_MINOR.PATCH; a -pre tag never publishes`,
      );
    } else if (`${match[1]}.${match[2]}.${match[3]}` !== manifest.version) {
      problems.push(`Tag ${tag} does not match package version ${manifest.version}`);
    }
  }
  if (tags && channel === 'pre-release') problems.push(...aboveStableProblems(manifest.version, tags));
  problems.push(...pinProblems(manifest, { lock, stable: channel === 'stable' }));
  const heading = changelogHeading ?? manifest.version;
  if (changelog !== undefined && !changelogHasSection(changelog, heading)) {
    problems.push(`CHANGELOG.md has no "## [${heading}]" section`);
  }
  if (linked.length > 0) {
    problems.push(
      `A ${channel} can't ship sibling builds: ${linked.join(', ')}. Run npm ci with ZENWAVE_USE_LOCAL_DEPENDENCIES=false`,
    );
  }
  return problems;
}

/** spec:release#r-r8. The workflow's run number replaces the patch. Text in, text out, so the file keeps its line ends. */
export function stampVersion(manifestText, runNumber) {
  if (!Number.isInteger(runNumber) || runNumber < 1) throw new Error(`Run number ${runNumber} is not a positive integer`);
  const pattern = /^(  "version": ")(\d+)\.(\d+)\.\d+(")/m;
  const match = pattern.exec(manifestText);
  if (!match) throw new Error('package.json has no top-level "version" of the form major.minor.patch');
  return {
    text: manifestText.replace(pattern, `$1$2.$3.${runNumber}$4`),
    version: `${match[2]}.${match[3]}.${runNumber}`,
  };
}

/** spec:release#r-r10. `## [Unreleased]` becomes the stamped version and date; fails without it. */
export function stampChangelog(changelogText, version, date) {
  const pattern = /^## \[Unreleased\][^\S\r\n]*$/m;
  if (!pattern.test(changelogText)) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  return changelogText.replace(pattern, `## [${version}] - ${date}`);
}
