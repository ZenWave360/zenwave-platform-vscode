import * as esbuild from 'esbuild';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Two bundles from one source tree.
 *
 * The only difference that matters is `platform`. Everything reachable from
 * `src/browser/extension.ts` must be free of Node APIs — esbuild will happily
 * bundle `node:fs` for the browser target and it will fail at runtime inside the
 * Web Worker host, where it is awkward to debug. Keeping the Node surface
 * confined to `src/node/` is what prevents that.
 */
const targets = [
  {
    name: 'node',
    entryPoints: ['src/node/extension.ts'],
    outfile: 'dist/node/extension.js',
    platform: 'node',
    target: 'node20',
  },
  {
    name: 'browser',
    entryPoints: ['src/browser/extension.ts'],
    outfile: 'dist/browser/extension.js',
    platform: 'browser',
    target: 'es2022',
  },
];

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
      plugins: [reporter(target.name)],
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  // esbuild throws on a failed build. The reporter plugin has already printed
  // the diagnostics in matcher-readable form by then, so swallow the throw and
  // fail by exit code — a Node stack trace here would bury the real errors.
  const results = await Promise.allSettled(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  if (results.some((result) => result.status === 'rejected')) {
    process.exitCode = 1;
  }
}
