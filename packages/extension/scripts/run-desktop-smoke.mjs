import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from '@vscode/test-electron';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagedVsix = process.env.ZENWAVE_SMOKE_VSIX;

try {
  const vscodeExecutablePath = packagedVsix
    ? await downloadAndUnzipVSCode('stable')
    : undefined;
  if (packagedVsix) {
    await runVSCodeCommand(['--install-extension', path.resolve(packagedVsix), '--force'], {
      version: 'stable',
    });
  }
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: packagedVsix
      ? path.join(projectDir, 'test/smoke-harness')
      : projectDir,
    extensionTestsPath: path.join(projectDir, '.test-dist/node/index.js'),
    launchArgs: [
      path.join(projectDir, 'fixtures'),
      ...(packagedVsix ? [] : ['--disable-extensions']),
    ],
  });
} catch (error) {
  console.error('Desktop extension-host smoke test failed', error);
  process.exitCode = 1;
}
