import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-web';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDevelopmentPath = process.env.ZENWAVE_SMOKE_EXTENSION_PATH
  ? path.resolve(process.env.ZENWAVE_SMOKE_EXTENSION_PATH)
  : projectDir;

try {
  await runTests({
    browserType: 'chromium',
    quality: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath: path.join(projectDir, '.test-dist/browser/index.js'),
    folderPath: path.join(projectDir, 'fixtures'),
    headless: true,
  });
} catch (error) {
  console.error('Browser extension-host smoke test failed', error);
  process.exitCode = 1;
}
