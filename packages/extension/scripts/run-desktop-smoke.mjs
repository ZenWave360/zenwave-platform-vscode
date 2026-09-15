import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  await runTests({
    extensionDevelopmentPath: projectDir,
    extensionTestsPath: path.join(projectDir, '.test-dist/node/index.js'),
    launchArgs: [path.join(projectDir, 'fixtures'), '--disable-extensions'],
  });
} catch (error) {
  console.error('Desktop extension-host smoke test failed', error);
  process.exitCode = 1;
}
