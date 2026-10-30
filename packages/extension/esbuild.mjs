import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkedSiblings } from './scripts/siblings.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const buildCommit = process.env.ZENWAVE_BUILD_COMMIT?.trim() || 'development';
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
);

/** A sibling linked by scripts/siblings.mjs is whatever that checkout last built, so its version can't match the pin. */
const isLinkedSibling = (packageName) => linkedSiblings().some((sibling) => sibling.package === packageName);

/**
 * The language server is `@zenwave360/lsp-js`, shipped inside the VSIX: its two
 * self-contained bundles are copied into dist/server. The version is pinned in
 * package.json (`zenwaveLanguageServer`), with the same version as a dev
 * dependency. See README "Development dependencies" and decision 0006.
 */
const SERVER_BUNDLES = [
  { exportName: './node', target: 'dist/server/node/zenwave-lsp-server.js' },
  { exportName: './worker', target: 'dist/server/browser/zenwave-lsp-worker.js' },
];

const NEWLINE_INDENT = '\n  ';

function languageServerPackage() {
  const pinned = packageManifest.zenwaveLanguageServer;
  const help = [
    `${pinned.package}@${pinned.version} is needed to build the extension. Run npm ci, or link a local build without saving it:`,
    `  npm install --no-save --workspace packages/extension <zenwave-lsp>/lsp-js/build/npm-pack/zenwave360-lsp-js-${pinned.version}.tgz`,
    `or point ZENWAVE_LSP_JS_DIR at the unpacked package (<zenwave-lsp>/lsp-js/build/npm-package).`,
  ].join(NEWLINE_INDENT);
  let directory = process.env.ZENWAVE_LSP_JS_DIR?.trim();
  const versionMustMatch = Boolean(directory) || !isLinkedSibling(pinned.package);
  if (directory) {
    directory = path.resolve(directory);
  } else {
    try {
      directory = path.dirname(createRequire(path.join(projectDir, 'package.json')).resolve(`${pinned.package}/package.json`));
    } catch {
      throw new Error(`${pinned.package} is not installed.${NEWLINE_INDENT}${help}`);
    }
  }
  const manifestFile = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`ZENWAVE_LSP_JS_DIR=${directory} holds no package.json.${NEWLINE_INDENT}${help}`);
  }
  const found = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (found.name !== pinned.package || (versionMustMatch && found.version !== pinned.version)) {
    throw new Error(`Found ${found.name}@${found.version} in ${directory}, expected ${pinned.package}@${pinned.version}.${NEWLINE_INDENT}${help}`);
  }
  return SERVER_BUNDLES.map(({ exportName, target }) => {
    const entry = found.exports?.[exportName];
    const source = typeof entry === 'string' ? path.join(directory, entry) : undefined;
    if (!source || !fs.existsSync(source)) {
      throw new Error(`${pinned.package}@${pinned.version} in ${directory} has no "${exportName}" bundle.${NEWLINE_INDENT}${help}`);
    }
    return { source, target: path.join(projectDir, target) };
  });
}

/**
 * The EventFlow diagram page is `@zenwave360/vistas-eventflow-webview`, built in
 * zenwave-architectural-vistas and shipped inside the VSIX: its `webview/` page
 * (index.html plus content-hashed assets) is copied into dist/eventflow-webview.
 * As with the language server, the exact package version and the page protocol
 * version are pinned in package.json (`zenwaveEventFlowWebview`), with the same
 * version as a dev dependency.
 * The build fails when the page states another protocol version than the one
 * pinned, so a protocol change cannot reach the VSIX silently; at runtime the
 * editor checks the version the page announces as well. See 004 design
 * §Decision (task 1.5).
 */
function eventFlowWebviewPackage() {
  const pinned = packageManifest.zenwaveEventFlowWebview;
  const help = [
    `${pinned.package}@${pinned.version} is needed to build the extension. Run npm ci, or`,
    'point ZENWAVE_VISTAS_WEBVIEW_DIR (absolute path) at the unpacked package, either',
    '  <zenwave-architectural-vistas>/packages/eventflow-webview after `pnpm --filter @zenwave360/vistas-eventflow-webview build`,',
    `  or the package/ directory extracted from zenwave360-vistas-eventflow-webview-${pinned.version}.tgz.`,
  ].join(NEWLINE_INDENT);
  let directory = process.env.ZENWAVE_VISTAS_WEBVIEW_DIR?.trim();
  const versionMustMatch = Boolean(directory) || !isLinkedSibling(pinned.package);
  if (directory) {
    directory = path.resolve(directory);
  } else {
    try {
      directory = path.dirname(createRequire(path.join(projectDir, 'package.json')).resolve(`${pinned.package}/package.json`));
    } catch {
      throw new Error(`${pinned.package} is not installed.${NEWLINE_INDENT}${help}`);
    }
  }
  const manifestFile = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`ZENWAVE_VISTAS_WEBVIEW_DIR=${directory} holds no package.json.${NEWLINE_INDENT}${help}`);
  }
  const found = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (found.name !== pinned.package || (versionMustMatch && found.version !== pinned.version)) {
    throw new Error(`Found ${found.name}@${found.version} in ${directory}, expected ${pinned.package}@${pinned.version}.${NEWLINE_INDENT}${help}`);
  }
  const page = path.join(directory, 'webview');
  const protocolFile = path.join(page, 'protocol.json');
  if (!fs.existsSync(path.join(page, 'index.html')) || !fs.existsSync(protocolFile)) {
    throw new Error(`${pinned.package}@${pinned.version} in ${directory} has no built webview/index.html and webview/protocol.json.${NEWLINE_INDENT}${help}`);
  }
  const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
  if (protocol.protocol !== pinned.protocol || protocol.protocolVersion !== pinned.protocolVersion) {
    throw new Error(`${pinned.package}@${pinned.version} speaks ${protocol.protocol} version ${protocol.protocolVersion}; ` +
      `this extension is pinned to ${pinned.protocol} version ${pinned.protocolVersion}.`);
  }
  return page;
}

function copyEventFlowWebview(page) {
  const target = path.join(projectDir, 'dist/eventflow-webview');
  // Asset names carry content hashes: stale ones from an earlier build must not linger.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(page, 'index.html'), path.join(target, 'index.html'));
  for (const entry of fs.readdirSync(path.join(page, 'assets'))) {
    if (/\.(js|css)$/.test(entry)) fs.copyFileSync(path.join(page, 'assets', entry), path.join(target, 'assets', entry));
  }
  const pinned = packageManifest.zenwaveEventFlowWebview;
  console.log(`[eventflow] copied ${pinned.package}@${pinned.version} (protocol version ${pinned.protocolVersion})`);
}

function copyLanguageServer(bundles) {
  for (const { source, target } of bundles) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  console.log(`[server] copied ${packageManifest.zenwaveLanguageServer.package}@${packageManifest.zenwaveLanguageServer.version}`);
}

let serverBundles = [];
let eventFlowPage;
if (!tests) {
  try {
    serverBundles = languageServerPackage();
    eventFlowPage = eventFlowWebviewPackage();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

if (production && !tests) {
  // A development build leaves source maps in dist. Start a release build from
  // an empty generated-output directory so stale files cannot enter the VSIX.
  fs.rmSync(path.join(projectDir, 'dist'), { recursive: true, force: true });
}

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const rejectNodeApis = {
  name: 'reject-node-apis',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (nodeBuiltins.has(args.path)) {
        return {
          errors: [
            {
              text: `Node API "${args.path}" is reachable from the browser bundle`,
            },
          ],
        };
      }
      return undefined;
    });
  },
};

/**
 * Two bundles from one source tree.
 *
 * The only difference that matters is `platform`. Everything reachable from
 * `src/browser/extension.ts` must be free of Node APIs — esbuild will happily
 * bundle `node:fs` for the browser target and it will fail at runtime inside the
 * Web Worker host, where it is awkward to debug. Keeping the Node surface
 * confined to `src/node/` is what prevents that.
 */
const extensionTargets = [
  {
    name: 'node',
    entryPoints: [path.join(projectDir, 'src/node/extension.ts')],
    outfile: path.join(projectDir, 'dist/node/extension.js'),
    platform: 'node',
    target: 'node20',
  },
  {
    name: 'browser',
    entryPoints: [path.join(projectDir, 'src/browser/extension.ts')],
    outfile: path.join(projectDir, 'dist/browser/extension.js'),
    platform: 'browser',
    target: 'es2022',
  },
];

const testTargets = extensionTargets.map((target) => ({
  ...target,
  name: `${target.name}-smoke`,
  entryPoints: [path.join(projectDir, 'test/smoke.ts')],
  outfile: path.join(projectDir, `.test-dist/${target.name}/index.js`),
}));

const targets = tests ? testTargets : extensionTargets;

/**
 * Both targets build concurrently, but VS Code needs ONE begin/end pair per
 * rebuild to decide when a background task is idle. So the markers are emitted
 * on the transitions into and out of "something is building", not per target.
 */
let building = 0;

/**
 * Both targets compile the same shared sources, so one broken file in
 * `src/activate.ts` is reported twice — identical text, identical location.
 * Deduplicating per build cycle keeps the Problems panel honest.
 */
let seen = new Set();

/**
 * Diagnostics are printed as `file:line:col: severity: message` — one line, no
 * continuation — so `.vscode/tasks.json` can match them with a single regexp and
 * we do not depend on the esbuild problem-matcher extension being installed.
 *
 * Paths are absolute on purpose. esbuild reports them relative to ITS cwd
 * (`packages/extension`), while the VS Code task runs from the workspace root,
 * so a relative path would resolve to the wrong file.
 */
function report(name, messages, severity) {
  for (const message of messages) {
    const where = message.location
      ? `${path.resolve(message.location.file)}:${message.location.line}:${message.location.column}`
      : name;
    const line = `${where}: ${severity}: ${message.text}`;
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    console.error(line);
  }
}

const reporter = (name) => ({
  name: 'reporter',
  setup(build) {
    build.onStart(() => {
      if (building === 0) {
        seen = new Set();
        if (watch) {
          console.log('[watch] build started');
        }
      }
      building += 1;
    });

    build.onEnd((result) => {
      report(name, result.errors, 'error');
      report(name, result.warnings, 'warning');

      building -= 1;
      if (building === 0 && watch) {
        console.log('[watch] build finished');
      }
      if (!watch && result.errors.length === 0) {
        console.log(`[${name}] build finished`);
      }
    });
  },
});

const contexts = await Promise.all(
  targets.map((target) =>
    esbuild.context({
      absWorkingDir: projectDir,
      entryPoints: target.entryPoints,
      outfile: target.outfile,
      bundle: true,
      format: 'cjs',
      platform: target.platform,
      target: target.target,
      // Provided by the extension host at runtime, never bundled.
      external: ['vscode'],
      sourcemap: production ? false : 'linked',
      minify: production,
      logLevel: 'silent',
      plugins: [
        ...(target.platform === 'browser' ? [rejectNodeApis] : []),
        reporter(target.name),
      ],
      define: {
        __ZENWAVE_BUILD_COMMIT__: JSON.stringify(buildCommit),
      },
    }),
  ),
);

if (watch) {
  copyLanguageServer(serverBundles);
  copyEventFlowWebview(eventFlowPage);
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  // esbuild throws on a failed build. The reporter plugin has already printed
  // the diagnostics in matcher-readable form by then, so swallow the throw and
  // fail by exit code — a Node stack trace here would bury the real errors.
  const results = await Promise.allSettled(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  if (results.some((result) => result.status === 'rejected')) {
    process.exitCode = 1;
  } else if (!tests) {
    copyLanguageServer(serverBundles);
    copyEventFlowWebview(eventFlowPage);
    fs.mkdirSync(path.join(projectDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'dist/build-info.json'),
      `${JSON.stringify(
        {
          version: packageManifest.version,
          commit: buildCommit,
        },
        null,
        2,
      )}\n`,
    );
  }
}
