import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-web';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagedExtension = process.env.ZENWAVE_SMOKE_EXTENSION_PATH;
const testRoot = path.join(projectDir, '.vscode-test-web');
let staged;
let extensionDevelopmentPath = projectDir;
let extensionTestsPath = path.join(projectDir, '.test-dist/browser/index.js');
if (packagedExtension) {
  // test-web serves tests relative to its development-extension root. A test
  // outside that root becomes an unreachable URL. Stage a copy plus the test
  // sidecar, leaving the verified VSIX and extracted package untouched.
  fs.mkdirSync(testRoot, { recursive: true });
  staged = fs.mkdtempSync(path.join(testRoot, 'packaged-smoke-'));
  extensionDevelopmentPath = path.join(staged, 'extension');
  fs.cpSync(path.resolve(packagedExtension), extensionDevelopmentPath, { recursive: true });
  const testDirectory = path.join(extensionDevelopmentPath, '.test-dist/browser');
  fs.cpSync(path.join(projectDir, '.test-dist/browser'), testDirectory, { recursive: true });
  extensionTestsPath = path.join(testDirectory, 'index.js');
}

try {
  // The shared suite exercises shipped authoring and absence of SDK Run lenses
  // in the actual Web Worker host, including when CI supplies a packaged build.
  await runTests({
    browserType: 'chromium',
    quality: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath,
    folderPath: path.join(projectDir, 'fixtures'),
    headless: true,
  });
} catch (error) {
  console.error('Browser extension-host smoke test failed', error);
  process.exitCode = 1;
} finally {
  if (staged) {
    const relative = path.relative(path.resolve(testRoot), path.resolve(staged));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path');
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
