import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(projectDir, 'CHANGELOG.md'), 'utf8');
const tag = process.env.ZENWAVE_RELEASE_TAG?.trim();
const requestedOutput = process.argv[process.argv.indexOf('--out') + 1];
const output = requestedOutput || path.join(projectDir, `${manifest.name}-${manifest.version}.vsix`);

let preRelease = false;
if (tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(-pre)?$/.exec(tag);
  if (!match) {
    throw new Error(
      `Invalid release tag ${tag}; use vMAJOR.EVEN_MINOR.PATCH for stable or vMAJOR.ODD_MINOR.PATCH-pre for pre-release`,
    );
  }

  const [, major, minor, patch, suffix] = match;
  const tagVersion = `${major}.${minor}.${patch}`;
  preRelease = suffix === '-pre';

  if (tagVersion !== manifest.version) {
    throw new Error(`Tag ${tag} does not match package version ${manifest.version}`);
  }
  if (preRelease === (Number(minor) % 2 === 0)) {
    throw new Error(
      `Tag ${tag} uses the wrong minor-number channel: stable minors are even and pre-release minors are odd`,
    );
  }
  if (!changelog.includes(`## [${manifest.version}]`)) {
    throw new Error(`CHANGELOG.md has no release section for ${manifest.version}`);
  }
}

function run(command, args, extraEnvironment = {}) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd: projectDir,
    env: { ...process.env, ...extraEnvironment },
    shell: process.platform === 'win32' && command === 'npm',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${
        result.error ? `: ${result.error.message}` : ''
      }`,
    );
  }
}

run('node', ['esbuild.mjs', '--production']);

fs.mkdirSync(path.dirname(path.resolve(projectDir, output)), { recursive: true });
run('node', [
  require.resolve('@vscode/vsce/vsce'),
  'package',
  '--no-dependencies',
  '--out',
  output,
  ...(preRelease ? ['--pre-release'] : []),
]);
