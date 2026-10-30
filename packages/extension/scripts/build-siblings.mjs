// Builds what scripts/siblings.mjs links. Gradle rebuilds included builds by itself; npm can't, so a link shows whatever
// was built last. Run this after changing a sibling.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { linkSiblings, repositoryRoot } from './siblings.mjs';

const isWindows = process.platform === 'win32';
const gradlew = isWindows ? 'gradlew.bat' : './gradlew';

const BUILDS = [
  { directory: 'dsl-kotlin', command: gradlew, args: [':dsl-kotlin:jsProductionExecutableCompileSync', ':dsl-kotlin:jsPackageJson', '--console=plain'] },
  { directory: 'zenwave-lsp', command: gradlew, args: [':lsp-js:lspJsNpmPack', '--console=plain'] },
  { directory: 'zenwave-architectural-vistas', command: 'pnpm', args: ['--filter', '@zenwave360/vistas-eventflow-webview...', 'build'] },
];

/** The JDK a repository's .sdkmanrc asks for, when SDKMAN has it: dsl-kotlin and zenwave-lsp don't use the same one. */
function sdkmanJavaHome(directory) {
  const rc = path.join(directory, '.sdkmanrc');
  if (!fs.existsSync(rc)) return undefined;
  const version = /^java=(\S+)/m.exec(fs.readFileSync(rc, 'utf8'))?.[1];
  const home = version && path.join(os.homedir(), '.sdkman', 'candidates', 'java', version);
  return home && fs.existsSync(home) ? home : undefined;
}

for (const build of BUILDS) {
  const directory = path.resolve(repositoryRoot, '..', build.directory);
  if (!fs.existsSync(directory)) {
    console.log(`[siblings] ${build.directory}: no checkout, skipped`);
    continue;
  }
  const javaHome = sdkmanJavaHome(directory);
  console.log(`[siblings] ${build.directory}: ${build.command} ${build.args.join(' ')}`);
  const result = spawnSync(build.command, build.args, {
    cwd: directory,
    env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
    shell: isWindows,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${build.directory}: build failed with exit code ${result.status ?? 'unknown'}`);
  }
}

for (const line of linkSiblings()) console.log(`[siblings] ${line}`);
