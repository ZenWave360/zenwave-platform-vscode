import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-web';
import { finishBrowserSmoke, smokeTimeoutMs, withDeadline } from './smoke-deadline.mjs';

const timeoutMs = smokeTimeoutMs();
const timeoutMessage = `Browser extension-host smoke test timed out after ${timeoutMs}ms. The test page did not finish. A page that answers 500 leaves the test-web server and browser running, so this process is stopping.`;
const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagedExtension = process.env.ZENWAVE_SMOKE_EXTENSION_PATH;
// Not inside .vscode-test-web: test-web deletes that whole folder when it downloads a VS Code build it does not have
// cached, which on a fresh CI runner removed the staged copy before the server read it, and the page never loaded.
const testRoot = os.tmpdir();
let staged;
let extensionDevelopmentPath = projectDir;
let extensionTestsPath = path.join(projectDir, '.test-dist/browser/index.js');
if (packagedExtension) {
  // test-web serves tests relative to its development-extension root. A test
  // outside that root becomes an unreachable URL. Stage a copy plus the test
  // sidecar, leaving the verified VSIX and extracted package untouched.
  staged = fs.mkdtempSync(path.join(testRoot, 'zenwave-packaged-smoke-'));
  extensionDevelopmentPath = path.join(staged, 'extension');
  fs.cpSync(path.resolve(packagedExtension), extensionDevelopmentPath, { recursive: true });
  const testDirectory = path.join(extensionDevelopmentPath, '.test-dist/browser');
  fs.cpSync(path.join(projectDir, '.test-dist/browser'), testDirectory, { recursive: true });
  extensionTestsPath = path.join(testDirectory, 'index.js');
}

// The rejected deadline does not stop the server or the browser. There is no handle to close them.
// finishBrowserSmoke removes a staged copy and, on a timeout, exits, which stops this process.
await finishBrowserSmoke(undefined, undefined, (code) => process.exit(code), {
  // The shared suite exercises shipped authoring and absence of SDK Run lenses
  // in the actual Web Worker host, including when CI supplies a packaged build.
  // test-web's promise stays pending when the page answers 500, so the deadline has to reject it.
  run: () => withDeadline(runTests({
    browserType: 'chromium',
    quality: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath,
    folderPath: path.join(projectDir, 'fixtures'),
    headless: true,
  }), timeoutMs, timeoutMessage),
  cleanup() {
    if (!staged) return;
    const relative = path.relative(path.resolve(testRoot), path.resolve(staged));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path');
    fs.rmSync(staged, { recursive: true, force: true });
  },
});
