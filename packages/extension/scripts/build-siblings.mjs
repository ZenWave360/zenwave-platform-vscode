// Builds what scripts/siblings.mjs links. Gradle rebuilds included builds by itself; npm can't, so a link shows whatever
// was built last. Run this after changing a sibling.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { linkSiblings, repositoryRoot } from './siblings.mjs';

export const SIBLING_BUILDS = [
  { directory: 'dsl-kotlin', tool: 'gradle', args: [':dsl-kotlin:jsProductionExecutableCompileSync', ':dsl-kotlin:jsPackageJson', '--console=plain'] },
  { directory: 'zenwave-lsp', tool: 'gradle', args: [':lsp-js:lspJsNpmPack', '--console=plain'] },
  { directory: 'zenwave-architectural-vistas', tool: 'pnpm', args: ['--filter', '@zenwave360/vistas-eventflow-webview...', 'build'] },
];

/**
 * Command for one sibling build. The Gradle wrapper is its absolute path inside that checkout: cmd.exe does not
 * search the current directory when NoDefaultCurrentDirectoryInExePath is set, so a bare gradlew.bat is not found.
 * pnpm stays a bare name.
 */
export function siblingBuildCommand(root, build, platform = process.platform) {
  const directory = path.resolve(root, '..', build.directory);
  const shell = platform === 'win32';
  if (build.tool === 'pnpm') return { directory, command: 'pnpm', args: build.args, shell };
  const wrapper = platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  return { directory, command: path.join(directory, wrapper), args: build.args, shell };
}

/** The JDK a repository's .sdkmanrc asks for, when SDKMAN has it: dsl-kotlin and zenwave-lsp don't use the same one. */
function sdkmanJavaHome(directory) {
  const rc = path.join(directory, '.sdkmanrc');
  if (!fs.existsSync(rc)) return undefined;
  const version = /^java=(\S+)/m.exec(fs.readFileSync(rc, 'utf8'))?.[1];
  const home = version && path.join(os.homedir(), '.sdkman', 'candidates', 'java', version);
  return home && fs.existsSync(home) ? home : undefined;
}

function runSiblingBuilds() {
  for (const build of SIBLING_BUILDS) {
    const planned = siblingBuildCommand(repositoryRoot, build);
    if (!fs.existsSync(planned.directory)) {
      console.log(`[siblings] ${build.directory}: no checkout, skipped`);
      continue;
    }
    const javaHome = sdkmanJavaHome(planned.directory);
    console.log(`[siblings] ${build.directory}: ${planned.command} ${planned.args.join(' ')}`);
    const result = spawnSync(planned.command, planned.args, {
      cwd: planned.directory,
      env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
      shell: planned.shell,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`${build.directory}: build failed with exit code ${result.status ?? 'unknown'}`);
    }
  }

  for (const line of linkSiblings()) console.log(`[siblings] ${line}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runSiblingBuilds();
}
