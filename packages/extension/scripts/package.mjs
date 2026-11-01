import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { releaseProblems } from './release-rules.mjs';
import { linkedSiblings, repositoryRoot } from './siblings.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(projectDir, 'CHANGELOG.md'), 'utf8');
const tag = process.env.ZENWAVE_RELEASE_TAG?.trim();
const outFlagIndex = process.argv.indexOf('--out');
const requestedOutput = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
if (outFlagIndex >= 0 && !requestedOutput) {
  throw new Error('Missing value for --out');
}
const output = requestedOutput || path.join(projectDir, `${manifest.name}-${manifest.version}.vsix`);

// ZENWAVE_RELEASE_TAG selects the stable channel, ZENWAVE_RELEASE_CHANNEL=pre-release the pre-release one; with neither
// this is a development package and nothing below is enforced. The rules are in release-rules.mjs, shared with release.mjs.
const channel = tag ? 'stable' : process.env.ZENWAVE_RELEASE_CHANNEL?.trim() || undefined;
if (channel !== undefined && channel !== 'stable' && channel !== 'pre-release') {
  throw new Error(`Invalid ZENWAVE_RELEASE_CHANNEL ${channel}; use pre-release`);
}
const preRelease = channel === 'pre-release';
const linked = linkedSiblings().map((sibling) => sibling.package);

if (channel) {
  const problems = releaseProblems({
    channel,
    manifest,
    changelog,
    lock: JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')),
    tag,
    linked,
  });
  if (problems.length > 0) {
    throw new Error(`Not releasable as ${channel}:\n  ${problems.join('\n  ')}`);
  }
} else if (linked.length > 0) {
  console.warn(`warning: this VSIX ships sibling builds: ${linked.join(', ')}`);
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
