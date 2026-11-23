// Links the built packages of sibling checkouts into node_modules, the npm counterpart of the composite builds in
// zenwave-lsp/settings.gradle.kts: a sibling that exists and is built wins, anything else comes from the registry.
// Runs as the root postinstall, because npm replaces the links on every install. CI opts out with
// ZENWAVE_USE_LOCAL_DEPENDENCIES=false.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SIBLINGS = [
  { package: '@zenwave360/dsl', directory: 'dsl-kotlin/build/js/packages/dsl-kotlin', built: 'kotlin' },
  { package: '@zenwave360/lsp-js', directory: 'zenwave-lsp/lsp-js/build/npm-package', built: 'dist' },
  { package: '@zenwave360/vistas-eventflow-webview', directory: 'zenwave-architectural-vistas/packages/eventflow-webview', built: 'webview/index.html' },
];

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function installedPath(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The siblings currently linked into node_modules. */
export function linkedSiblings(root = repositoryRoot) {
  return SIBLINGS.filter((sibling) => isLink(installedPath(root, sibling.package)));
}

function pinnedVersions(manifest, packageName) {
  const versions = [
    manifest.dependencies?.[packageName],
    manifest.devDependencies?.[packageName],
    manifest.optionalDependencies?.[packageName],
    manifest.peerDependencies?.[packageName],
  ];
  if (manifest.zenwaveLanguageServer?.package === packageName) versions.push(manifest.zenwaveLanguageServer.version);
  if (manifest.zenwaveEventFlowWebview?.package === packageName) versions.push(manifest.zenwaveEventFlowWebview.version);
  return versions.filter((version) => typeof version === 'string');
}

function displayPath(root, directory) {
  const relative = path.relative(root, directory).replaceAll(path.sep, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Problems with linked sibling versions that would make a VSIX differ from its package.json pins.
 *
 * Package scripts may link a sibling for local development. Packaging may use that link only when every
 * applicable package.json pin agrees with its package.json version.
 */
export function linkedSiblingVersionProblems(manifest, root = repositoryRoot) {
  return linkedSiblings(root).flatMap((sibling) => {
    const directory = fs.realpathSync(installedPath(root, sibling.package));
    const linkedVersion = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    return [...new Set(pinnedVersions(manifest, sibling.package))]
      .filter((pinnedVersion) => pinnedVersion !== linkedVersion)
      .map(
        (pinnedVersion) =>
          `${sibling.package} is linked at ${displayPath(root, directory)} with version ${linkedVersion}, but package.json pins ${pinnedVersion}. ` +
          'Fix it with ZENWAVE_USE_LOCAL_DEPENDENCIES=false then npm ci.',
      );
  });
}

/** A built sibling's package directory, or undefined if it isn't there to link. */
function builtSibling(root, sibling) {
  const directory = path.resolve(root, '..', sibling.directory);
  const manifestFile = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestFile) || !fs.existsSync(path.join(directory, sibling.built))) return undefined;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return manifest.name === sibling.package ? { directory, manifest } : undefined;
}

/** Links what is built, leaves the rest alone, and returns one line per sibling. */
export function linkSiblings(root = repositoryRoot, environment = process.env) {
  const enabled = environment.ZENWAVE_USE_LOCAL_DEPENDENCIES?.trim().toLowerCase() !== 'false';
  return SIBLINGS.map((sibling) => {
    const target = installedPath(root, sibling.package);
    if (!enabled) {
      if (!isLink(target)) return `${sibling.package}: from the registry`;
      fs.rmSync(target);
      return `${sibling.package}: link removed, run npm ci to install it from the registry`;
    }
    const found = builtSibling(root, sibling);
    if (!found) return `${sibling.package}: from the registry (no build in ../${sibling.directory})`;
    if (isLink(target)) fs.rmSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(found.directory, target, 'junction');
    const builtAt = fs.statSync(path.join(found.directory, sibling.built)).mtime.toISOString();
    return `${sibling.package}: linked to ../${sibling.directory} (${found.manifest.version}, built ${builtAt})`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  for (const line of linkSiblings()) console.log(`[siblings] ${line}`);
}
