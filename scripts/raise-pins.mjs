// Raises the `@zenwave360/*` pins to what npm `next` is now (spec:release#r-r9), in every place a pin lives:
// the extension's package.json, the `zenwaveLanguageServer` / `zenwaveEventFlowWebview` block of the same file, and
// package-lock.json. It commits nothing: the commit that results is what starts the pre-release pipeline.
//
//   node scripts/raise-pins.mjs [--include @zenwave360/dsl] [--dry-run]
//
// `@zenwave360/dsl` is stable and not needed from `next`, so it is raised only when named with --include.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isExactVersion, PIN_BLOCKS, pinnedVersions } from './release-rules.mjs';

export const RAISED_BY_DEFAULT = ['@zenwave360/lsp-js', '@zenwave360/vistas-eventflow-webview'];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The manifest text with each package pinned to its new version, in its dependency entry and in its block. */
export function raisePinsText(manifestText, versions) {
  const manifest = JSON.parse(manifestText);
  let text = manifestText;
  for (const [name, version] of Object.entries(versions)) {
    if (!isExactVersion(version)) throw new Error(`${name}: "${version}" is not an exact version`);
    const entry = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")[^"]*(")`, 'g');
    if ((text.match(entry) ?? []).length !== 1) {
      throw new Error(`${name} must be declared exactly once in package.json, found ${(text.match(entry) ?? []).length}`);
    }
    text = text.replace(entry, `$1${version}$2`);
    for (const key of PIN_BLOCKS.filter((block) => manifest[block]?.package === name)) {
      const block = new RegExp(`("${key}"\\s*:\\s*\\{[^}]*?"version"\\s*:\\s*")[^"]*(")`);
      if (!block.test(text)) throw new Error(`${key} has no "version" to raise`);
      text = text.replace(block, `$1${version}$2`);
    }
  }
  return text;
}

/** npm is a .cmd on Windows, which only a shell starts; the arguments here are fixed words. */
function npm(args, options, run) {
  return process.platform === 'win32'
    ? run(`npm ${args.join(' ')}`, { ...options, shell: true })
    : run('npm', args, options);
}

/** What npm `next` is for a package, or an error naming it. */
export function npmNext(name, run = spawnSync) {
  const result = npm(['view', name, 'dist-tags.next'], { encoding: 'utf8' }, run);
  const version = result.stdout?.trim();
  if (result.status !== 0 || !version) throw new Error(`npm has no "next" version of ${name}: ${result.stderr || 'empty answer'}`);
  return version;
}

/**
 * Forgets the lockfile's entries for these packages, so npm resolves them again. Left in place, npm keeps the old entry
 * hoisted and puts the new version in node_modules, where it shadows a linked sibling and where
 * the lockfile check does not look.
 */
export function dropLockEntries(root, names) {
  const file = path.join(root, 'package-lock.json');
  const text = fs.readFileSync(file, 'utf8');
  const lock = JSON.parse(text);
  for (const name of names) {
    for (const key of Object.keys(lock.packages).filter((entry) => entry.endsWith(`node_modules/${name}`))) {
      delete lock.packages[key];
    }
  }
  const json = `${JSON.stringify(lock, null, 2)}\n`;
  fs.writeFileSync(file, text.includes('\r\n') ? json.replaceAll('\n', '\r\n') : json);
}

/** Makes package-lock.json agree with package.json, without installing anything. */
export function syncLockfile(root, run = spawnSync) {
  const result = npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' }, run);
  if (result.status !== 0) throw new Error('npm install --package-lock-only failed');
}

/**
 * Raises the pins and returns one line per package. `latest` and `syncLock` are injected so the tests need no network.
 */
export function raisePins({ extensionDirectory, root, include = [], dryRun = false, latest = npmNext, syncLock = syncLockfile }) {
  const manifestFile = path.join(extensionDirectory, 'package.json');
  const text = fs.readFileSync(manifestFile, 'utf8');
  const current = pinnedVersions(JSON.parse(text));
  const names = [...RAISED_BY_DEFAULT, ...include];
  const unknown = names.filter((name) => current[name] === undefined);
  if (unknown.length > 0) throw new Error(`Not a dependency of the extension: ${unknown.join(', ')}`);

  const target = Object.fromEntries(names.map((name) => [name, latest(name)]));
  const changed = Object.fromEntries(names.filter((name) => target[name] !== current[name]).map((name) => [name, target[name]]));
  const lines = names.map((name) =>
    changed[name] ? `${name}: ${current[name]} -> ${target[name]}` : `${name}: ${current[name]} is already next`,
  );
  if (Object.keys(changed).length === 0 || dryRun) return lines;

  fs.writeFileSync(manifestFile, raisePinsText(text, changed));
  dropLockEntries(root, Object.keys(changed));
  syncLock(root);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const include = args.flatMap((arg, index) => (arg === '--include' ? [args[index + 1]] : []));
  const extensionDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  try {
    for (const line of raisePins({ extensionDirectory, root: extensionDirectory, include, dryRun: args.includes('--dry-run') })) {
      console.log(line);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
