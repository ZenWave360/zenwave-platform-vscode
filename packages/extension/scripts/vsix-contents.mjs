/**
 * What a VSIX must and must not contain. Pure, so the rules can be tested without
 * building a package; `verify-vsix.mjs` supplies the real inputs.
 */

/** Directories whose every file is a runtime asset that must be listed by name. */
export const RUNTIME_DIRECTORIES = ['dist', 'resources', 'syntaxes'];

const ALWAYS_REQUIRED = ['package.json', 'readme.md', 'changelog.md', 'LICENSE.txt'];

const FORBIDDEN = [
  /^extension\/(src|test|tests|fixtures|scripts)\//,
  /^extension\/\.vscode/,
  /^extension\/.*\.(?:ts|tsx|map|tsbuildinfo)$/,
  /^extension\/(?:esbuild\.mjs|tsconfig\.json|runtime-files\.json)$/,
];

function normalize(file) {
  return file.replace(/^\.\//, '').replaceAll('\\', '/');
}

/** An entry with `*` in its last segment names files whose names change per build, such as content hashes. */
function isPattern(entry) {
  return entry.includes('*');
}

function patternRegex(entry) {
  const slash = entry.lastIndexOf('/');
  if (entry.slice(0, slash + 1).includes('*')) {
    throw new Error(`runtime-files.json entry ${entry}: * is allowed only in the file name`);
  }
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(entry.slice(0, slash + 1))}${entry.slice(slash + 1).split('*').map(escape).join('[^/]+')}$`);
}

/** Files the manifest itself points at: entry points, icons, grammars, language configuration. */
export function manifestReferences(manifest) {
  const contributes = manifest.contributes ?? {};
  return [
    manifest.main,
    manifest.browser,
    manifest.icon,
    ...(contributes.grammars ?? []).map((grammar) => grammar.path),
    ...(contributes.languages ?? []).flatMap((language) => [
      language.configuration,
      language.icon?.light,
      language.icon?.dark,
    ]),
  ]
    .filter((file) => typeof file === 'string')
    .map(normalize);
}

/**
 * @param {object} input
 * @param {string[]} input.listed     runtime files named in runtime-files.json
 * @param {object}   input.manifest   the extension's package.json
 * @param {string[]} input.onDisk     files found under RUNTIME_DIRECTORIES after the build
 * @param {string[]} input.packaged   entry names in the VSIX
 * @returns {string[]} problems; empty when the package is sound
 */
export function checkPackageContents({ listed, manifest, onDisk, packaged }) {
  const problems = [];
  const entries = listed.map(normalize);
  const patterns = entries.filter(isPattern).map((entry) => ({ entry, regex: patternRegex(entry) }));
  const listedSet = new Set(entries.filter((entry) => !isPattern(entry)));
  const packagedSet = new Set(packaged.map(normalize));
  const isListed = (file) => listedSet.has(file) || patterns.some(({ regex }) => regex.test(file));

  for (const file of manifestReferences(manifest)) {
    if (!isListed(file)) {
      problems.push(`package.json refers to ${file}, which runtime-files.json does not list`);
    }
  }
  for (const file of onDisk.map(normalize)) {
    if (!file.endsWith('.map') && !isListed(file)) {
      problems.push(`${file} is a runtime file that runtime-files.json does not list`);
    }
  }
  for (const file of [...ALWAYS_REQUIRED, ...listedSet]) {
    if (!packagedSet.has(`extension/${file}`)) {
      problems.push(`VSIX is missing required runtime file: extension/${file}`);
    }
  }
  for (const { entry, regex } of patterns) {
    if (![...packagedSet].some((file) => file.startsWith('extension/') && regex.test(file.slice('extension/'.length)))) {
      problems.push(`VSIX is missing required runtime file: extension/${entry}`);
    }
  }
  for (const file of packagedSet) {
    if (FORBIDDEN.some((pattern) => pattern.test(file))) {
      problems.push(`VSIX contains development-only file: ${file}`);
    }
  }
  return problems;
}
