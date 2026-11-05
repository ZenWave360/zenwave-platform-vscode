import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error The installed YAML parser has no type declarations.
import { load } from 'js-yaml';
// @ts-expect-error A build script without type declarations.
import { parseExtensionVersion } from '../../scripts/release-rules.mjs';

// The rules are tested as functions; these tests hold the workflow and the scripts to what the rules need to see.
const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, ...parts), 'utf8').replace(/\r\n/g, '\n');
const verify = read('../../.github/workflows/verify.yml');

/** The `run:` block of the step with this name, up to the next step. */
function step(name: string): string {
  const start = verify.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `verify.yml has no step "${name}"`);
  const next = verify.indexOf('\n      - name: ', start + 1);
  return verify.slice(start, next === -1 ? undefined : next);
}

test('R-R8 and R-R11 verify.yml gives the check the tags of the repository, and the pre-release its run number', () => {
  const check = step('Check the release rules');
  const stable = /check --channel stable [^\n]*/.exec(check)?.[0] ?? '';
  const preRelease = /check --channel pre-release [^\n]*/.exec(check)?.[0] ?? '';
  assert.match(stable, /--tag "\$REF_NAME"/);
  assert.match(stable, /--git-tags/, 'without it the -pre tag and the stable order are not checked');
  assert.match(preRelease, /--git-tags/);
  assert.match(preRelease, /--run-number "\$RUN_NUMBER"/);
  assert.match(check, /if: inputs\.channel != 'development'/);
});

test('R-R8 verify.yml checks out every branch and tag', () => {
  const checkout = step('Check out the commit');
  assert.match(checkout, /fetch-depth: 0\n/);
});

test('R-R10 verify.yml takes the GitHub release notes from the notes file, not from the generated changelog', () => {
  const describe = step('Describe the verified VSIX');
  assert.match(describe, /release\.mjs" notes --channel "\$CHANNEL" > artifacts\/release-notes\.md/);
  assert.ok(!/CHANGELOG/i.test(describe.replace(/#[^\n]*/g, '')), 'the notes are not cut from CHANGELOG.md');
});

test('pre-release.yml publishes only when ZENWAVE_PUBLISH_PRERELEASE is true, and the job that says it was held back has no secret and no environment', () => {
  const text = read('../../.github/workflows/pre-release.yml');
  const publish = text.slice(text.indexOf('\n  publish:'), text.indexOf('\n  withheld:'));
  const withheld = text.slice(text.indexOf('\n  withheld:'), text.indexOf('\n  trace:'));
  const trace = text.slice(text.indexOf('\n  trace:'));
  assert.match(/^ {4}if: (.*)$/m.exec(publish)?.[1] ?? '', /vars\.ZENWAVE_PUBLISH_PRERELEASE == 'true'/);
  assert.match(/^ {4}if: (.*)$/m.exec(withheld)?.[1] ?? '', /success\(\) && vars\.ZENWAVE_PUBLISH_PRERELEASE != 'true'/);
  assert.match(withheld, /needs\.verify\.outputs\.version/);
  assert.match(withheld, /ZENWAVE_PUBLISH_PRERELEASE/);
  assert.equal(withheld.includes('secrets.'), false);
  assert.equal(/^ {4}environment:/m.test(withheld), false);
  // A skipped publish sets no registry output. trace already requires one, so it skips and does not fail the run.
  assert.match(/^ {4}if: (.*)$/m.exec(trace)?.[1] ?? '', /needs\.publish\.outputs\.marketplace != ''/);
});

test('R-R10 verify:vsix checks the changelog of a channel build for the version section', () => {
  const script = read('../../scripts/verify-vsix.mjs');
  const channelBlock = script.slice(script.indexOf('if (channel) {'), script.indexOf('if (problems.length'));
  assert.match(channelBlock, /problems\.push\(\.\.\.changelogProblems\(archive, info\.version\)\)/);
});

const workflowDirectory = join(import.meta.dirname, '../../.github/workflows');
const VERSION_CHECK = '[[ ! "$VERSION" =~ $version_re ]]';
const VERSION_STEP_NAME = 'Check the version is major.minor.patch';
const VERSION_JOBS = [
  ['pre-release.yml', 'publish'],
  ['pre-release.yml', 'trace'],
  ['release.yml', 'publish'],
] as const;
const VALID_VERSION = '1.2.3';
const INVALID_VERSION = '01.2.3';
// Cases the workflow regex and parseExtensionVersion have to agree on, including leading zeros and a trailing command.
const VERSION_CASES = ['0.0.0', '0.1.0', '0.1.58', '10.20.30', '01.2.3', '1.02.3', '1.2.03', '1.2.3-pre', 'v1.2.3', '', '1.2', '1.2.3 ', '1.2.3;id'] as const;

function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `--jq` arguments. A flag glued to punctuation, as in a comment that mentions it, is not a program. */
function jqPrograms(text: string): string[] {
  const programs: string[] = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('--jq', index);
    if (at === -1) break;
    const before = at === 0 ? ' ' : text[at - 1];
    const after = text[at + 4];
    index = at + 4;
    if (!/\s/.test(before) || (after !== ' ' && after !== '\t' && after !== '\n' && after !== '=')) continue;
    if (after === '=') index++;
    while (text[index] === ' ' || text[index] === '\t') index++;
    const quote = text[index];
    if (quote === "'" || quote === '"') {
      index++;
      let program = '';
      while (index < text.length && text[index] !== quote) {
        if (quote === '"' && text[index] === '\\') {
          program += text[index + 1] ?? '';
          index += 2;
          continue;
        }
        program += text[index];
        index++;
      }
      programs.push(program);
      index++;
      continue;
    }
    const end = text.slice(index).search(/\s/);
    const program = end === -1 ? text.slice(index) : text.slice(index, index + end);
    programs.push(program);
    index += program.length;
  }
  return programs;
}

function firstCodeOffset(text: string, needle: string): number {
  let offset = 0;
  for (const line of text.split('\n')) {
    const code = line.replace(/#.*/, '');
    const at = code.indexOf(needle);
    if (at !== -1) return offset + at;
    offset += line.length + 1;
  }
  return -1;
}

type WorkflowStep = {
  name?: string;
  if?: unknown;
  run?: unknown;
  'continue-on-error'?: unknown;
};

// Parsed steps, so a later publish step's continue-on-error is not this check's (spec:release#r-r8, r-r11, r-r13).
function workflowSteps(text: string, jobName: string): WorkflowStep[] {
  const document = load(text) as { jobs?: Record<string, { steps?: WorkflowStep[] }> } | null;
  const steps = document?.jobs?.[jobName]?.steps;
  assert.ok(Array.isArray(steps) && steps.length > 0, `${jobName} has steps`);
  return steps;
}

function versionStep(text: string, file: string, jobName: string): WorkflowStep {
  const step = workflowSteps(text, jobName)[0];
  assert.ok(step, `${file} ${jobName} has a first step`);
  assert.equal(step.name, VERSION_STEP_NAME, `${file} ${jobName} checks the version at the start`);
  return step;
}

function stepRun(step: WorkflowStep): string {
  if (typeof step.run !== 'string') assert.fail('the version check has no run script');
  return step.run;
}

/** `continue-on-error: true` lets the job go on after the version check fails. Literal false does not. */
function continuesOnError(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (typeof value === 'string' && value.trim() === 'false') return false;
  return true;
}

/** A step `if` can skip the check. Only a literal true cannot. `if: false` skips it. */
function ifCanSkip(condition: unknown): boolean {
  if (condition === undefined || condition === true) return false;
  if (typeof condition === 'string' && condition.trim() === 'true') return false;
  return true;
}

function shellCode(run: string): string {
  return run.split('\n').map((line) => line.replace(/#.*/, '')).join('\n');
}

/** The parsed `run` block, with `VERSION` set. An early `exit 0` is status 0. */
function runVersionGuard(run: string, version: string): { status: number | null; output: string } {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-s'], {
    input: run.endsWith('\n') ? run : `${run}\n`,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, VERSION: version },
  });
  if (isEnoent(result.error)) assert.fail('bash is not on PATH');
  if (result.error) assert.fail(`bash failed to start: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Names the bypass when an invalid version exits 0. */
function guardBypass(run: string): string | undefined {
  if (runVersionGuard(run, INVALID_VERSION).status !== 0) return undefined;
  const code = shellCode(run);
  if (/\|\|\s*true\b/.test(code)) return '|| true swallows the version check failure';
  if (/\|\|\s*:/.test(code)) return '|| : swallows the version check failure';
  const checkAt = code.indexOf(VERSION_CHECK);
  if (checkAt === -1) return 'the version check never runs';
  if (/\bexit\s+0\b/.test(code.slice(0, checkAt))) return 'exit 0 before the version check skips it';
  if (/\bexit\s+0\b/.test(code.slice(checkAt + VERSION_CHECK.length))) {
    return 'exit 0 after the version check swallows the failure';
  }
  return 'an invalid version passes the version check';
}

function versionCheckProblems(step: WorkflowStep): string[] {
  const problems: string[] = [];
  if (continuesOnError(step['continue-on-error'])) {
    problems.push('continue-on-error lets the version check fail without stopping the job');
  }
  if (ifCanSkip(step.if)) problems.push('if can skip the version check');
  if (typeof step.run !== 'string') {
    problems.push('the version check has no run script');
    return problems;
  }
  if (!bashOnPath()) return problems;
  const bypass = guardBypass(step.run);
  if (bypass) problems.push(bypass);
  if (runVersionGuard(step.run, VALID_VERSION).status !== 0) problems.push('a valid version fails the version check');
  return problems;
}

function replaceJob(text: string, jobName: string, edit: (jobText: string) => string): string {
  const start = text.indexOf(`\n  ${jobName}:\n`);
  assert.notEqual(start, -1, `missing job ${jobName}`);
  const current = job(text, jobName);
  return text.slice(0, start + 1) + edit(current) + text.slice(start + 1 + current.length);
}

function replaceVersionStep(text: string, jobName: string, edit: (step: string) => string): string {
  return replaceJob(text, jobName, (jobText) => {
    const marker = `      - name: ${VERSION_STEP_NAME}\n`;
    const at = jobText.indexOf(marker);
    assert.notEqual(at, -1, `${jobName} has no version step`);
    const next = jobText.indexOf('\n      - ', at + marker.length);
    assert.notEqual(next, -1, `${jobName} version step has no following step`);
    const step = jobText.slice(at, next);
    const edited = edit(step);
    assert.notEqual(edited, step, `${jobName} version step was not changed`);
    return jobText.slice(0, at) + edited + jobText.slice(next);
  });
}

/** Replaces the version `if` with one command, so the fixture is the guard the job would run. */
function replaceVersionGuard(step: string, replacement: string): string {
  const start = step.indexOf('if [[ ! "$VERSION" =~ $version_re ]]; then\n');
  const end = step.indexOf('          fi\n', start);
  if (start === -1 || end === -1) return step;
  return `${step.slice(0, start)}${replacement}\n${step.slice(end + '          fi\n'.length)}`;
}

function versionRegex(run: string): string {
  const pattern = /^[ \t]*version_re=(['"])([^'"\n]*)\1/m.exec(run)?.[2];
  assert.ok(pattern, 'the version check assigns version_re');
  return pattern;
}

function bashSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isEnoent(error: Error | undefined): boolean {
  return error !== undefined && 'code' in error && error.code === 'ENOENT';
}

function bashOnPath(): boolean {
  const result = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8', windowsHide: true });
  return !isEnoent(result.error);
}

/** One `[[ $v =~ $version_re ]]` per version. Status 0 matches, 1 does not, anything else is a broken shell. */
function bashMatches(versionRe: string, versions: readonly string[]): boolean[] {
  const script = [
    `version_re=${bashSingleQuoted(versionRe)}`,
    ...versions.flatMap((version) => [`v=${bashSingleQuoted(version)}`, '[[ $v =~ $version_re ]]', 'printf "%s\\n" "$?"']),
    '',
  ].join('\n');
  const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', windowsHide: true });
  if (isEnoent(result.error)) assert.fail('bash is not on PATH');
  assert.equal(result.status, 0, `bash version regex failed: ${result.stderr}`);
  const codes = result.stdout.split('\n').filter((line) => line !== '');
  assert.equal(codes.length, versions.length, 'bash printed one result per version');
  return codes.map((code, index) => {
    if (code === '0') return true;
    if (code === '1') return false;
    assert.fail(`bash [[ $v =~ $version_re ]] failed for ${JSON.stringify(versions[index])} with status ${code}`);
  });
}

function versionRuleDisagreements(versionRe: string): string[] {
  const matched = bashMatches(versionRe, VERSION_CASES);
  const problems: string[] = [];
  for (let index = 0; index < VERSION_CASES.length; index++) {
    const version = VERSION_CASES[index] ?? '';
    const shell = matched[index] === true;
    const rules = parseExtensionVersion(version) !== undefined;
    if (shell !== rules) problems.push(`${JSON.stringify(version)}: bash ${shell}, parseExtensionVersion ${rules}`);
  }
  return problems;
}

test('no --jq program interpolates the version, the tag or a GitHub expression', () => {
  const files = readdirSync(workflowDirectory).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length > 0);
  const programs = files.flatMap((file) => jqPrograms(read('../../.github/workflows', file)).map((program) => `${file}: ${program}`));
  assert.ok(programs.length > 0, 'the workflows do use --jq');
  const interpolated = programs.filter((program) => /\$VERSION(?![A-Za-z0-9_])|\$tag(?![A-Za-z0-9_])|\$\{\{/.test(program));
  assert.deepEqual(interpolated, []);
  const trace = job(read('../../.github/workflows/pre-release.yml'), 'trace');
  assert.ok(jqPrograms(trace).includes('.[] | select(.ref == $ENV.TAG_REF) | .object.sha'));
});

test('publish and trace check the version format before they use it', () => {
  for (const [file, name] of VERSION_JOBS) {
    const text = read('../../.github/workflows', file);
    const label = `${file} ${name}`;
    const step = versionStep(text, file, name);
    const run = stepRun(step);
    assert.deepEqual(versionCheckProblems(step), [], `${label} must not skip or swallow the version check`);
    assert.ok(run.includes(VERSION_CHECK), `${label} checks the version`);
    const body = job(text, name);
    const checkAt = body.indexOf(VERSION_CHECK);
    const firstUse = firstCodeOffset(body, '$VERSION');
    assert.equal(firstUse, checkAt + VERSION_CHECK.indexOf('$VERSION'), `${label} checks the version before using it`);
    assert.match(run, /echo "::error::The version from verify is not major\.minor\.patch with no leading zeros, so this job stops\."\n\s+exit 1/);
  }
});

test('a mutated version check that is skipped is reported', () => {
  const header = `      - name: ${VERSION_STEP_NAME}\n`;
  const mutations: { label: string; reported: string; edit: (step: string) => string }[] = [
    {
      label: 'continue-on-error: true',
      reported: 'continue-on-error',
      edit: (step) => step.replace(header, `${header}        continue-on-error: true\n`),
    },
    {
      label: 'if: false',
      reported: 'if can skip',
      edit: (step) => step.replace(header, `${header}        if: false\n`),
    },
  ];
  for (const [file, name] of VERSION_JOBS) {
    const text = read('../../.github/workflows', file);
    for (const mutation of mutations) {
      const mutated = replaceVersionStep(text, name, mutation.edit);
      const problems = versionCheckProblems(versionStep(mutated, file, name));
      assert.ok(
        problems.some((problem) => problem.includes(mutation.reported)),
        `${file} ${name} ${mutation.label} should report ${mutation.reported}, got ${problems.join(', ') || 'nothing'}`,
      );
    }
  }
});

test('each version-check run block accepts a valid version and rejects an invalid one', (t) => {
  if (!bashOnPath()) {
    t.skip('bash is not on PATH, so the version-check run blocks were not executed');
    return;
  }
  for (const [file, name] of VERSION_JOBS) {
    const label = `${file} ${name}`;
    const run = stepRun(versionStep(read('../../.github/workflows', file), file, name));
    const valid = runVersionGuard(run, VALID_VERSION);
    const invalid = runVersionGuard(run, INVALID_VERSION);
    assert.equal(valid.status, 0, `${label} must accept ${VALID_VERSION}: ${valid.output}`);
    assert.notEqual(invalid.status, 0, `${label} must reject ${INVALID_VERSION}: ${invalid.output}`);
  }
});

test('an exit 0 before the version check lets an invalid version pass and is reported', (t) => {
  if (!bashOnPath()) {
    t.skip('bash is not on PATH, so the version-check run blocks were not executed');
    return;
  }
  for (const [file, name] of VERSION_JOBS) {
    const text = read('../../.github/workflows', file);
    const original = runVersionGuard(stepRun(versionStep(text, file, name)), INVALID_VERSION);
    assert.notEqual(original.status, 0, `${file} ${name} must reject ${INVALID_VERSION} before it is mutated`);
    const mutated = replaceVersionStep(text, name, (step) =>
      step.replace('\n          set -euo pipefail\n', '\n          exit 0\n          set -euo pipefail\n'),
    );
    const step = versionStep(mutated, file, name);
    const after = runVersionGuard(stepRun(step), INVALID_VERSION);
    assert.equal(
      after.status,
      0,
      `${file} ${name} prepended exit 0 must let ${INVALID_VERSION} pass, got ${after.status}: ${after.output}`,
    );
    const problems = versionCheckProblems(step);
    assert.ok(
      problems.some((problem) => problem.includes('exit 0 before the version check')),
      `${file} ${name} should report an exit 0 before the version check, got ${problems.join(', ') || 'nothing'}`,
    );
  }
});

test('a guard mutation that lets an invalid version pass is reported', (t) => {
  if (!bashOnPath()) {
    t.skip('bash is not on PATH, so the version-check run blocks were not executed');
    return;
  }
  const mutations: { label: string; reported: string; edit: (step: string) => string }[] = [
    {
      label: 'a check that never runs',
      reported: 'never runs',
      edit: (step) => step.replace('if [[ ! "$VERSION" =~ $version_re ]]; then', 'if false; then'),
    },
    {
      label: '|| true',
      reported: '|| true',
      edit: (step) => replaceVersionGuard(step, '[[ "$VERSION" =~ $version_re ]] || true'),
    },
    {
      label: '|| :',
      reported: '|| :',
      edit: (step) => replaceVersionGuard(step, '[[ "$VERSION" =~ $version_re ]] || :'),
    },
    {
      label: 'exit 0 after the check',
      reported: 'exit 0 after the version check',
      edit: (step) => step.replace('\n            exit 1\n', '\n            exit 0\n'),
    },
  ];
  for (const [file, name] of VERSION_JOBS) {
    const text = read('../../.github/workflows', file);
    const original = runVersionGuard(stepRun(versionStep(text, file, name)), INVALID_VERSION);
    assert.notEqual(original.status, 0, `${file} ${name} must reject ${INVALID_VERSION} before it is mutated`);
    for (const mutation of mutations) {
      const mutated = replaceVersionStep(text, name, mutation.edit);
      const step = versionStep(mutated, file, name);
      const after = runVersionGuard(stepRun(step), INVALID_VERSION);
      assert.equal(
        after.status,
        0,
        `${file} ${name} ${mutation.label} must let ${INVALID_VERSION} pass, got ${after.status}: ${after.output}`,
      );
      const problems = versionCheckProblems(step);
      assert.ok(
        problems.some((problem) => problem.includes(mutation.reported)),
        `${file} ${name} ${mutation.label} should report ${mutation.reported}, got ${problems.join(', ') || 'nothing'}`,
      );
    }
  }
});

test('the workflow version regex agrees with release-rules.mjs when bash runs it', (t) => {
  if (!bashOnPath()) {
    t.skip('bash is not on PATH, so the workflow version regex was not executed');
    return;
  }
  for (const [file, name] of VERSION_JOBS) {
    const run = stepRun(versionStep(read('../../.github/workflows', file), file, name));
    assert.deepEqual(versionRuleDisagreements(versionRegex(run)), [], `${file} ${name}`);
  }
  const mutated = replaceVersionStep(read('../../.github/workflows/pre-release.yml'), 'publish', (step) => step.replaceAll('[1-9]', '[0-9]'));
  const problems = versionRuleDisagreements(versionRegex(stepRun(versionStep(mutated, 'pre-release.yml', 'publish'))));
  assert.ok(
    problems.some((problem) => problem.startsWith('"01.2.3"')),
    `a version_re that allows leading zeros must disagree with parseExtensionVersion, got ${problems.join('; ') || 'nothing'}`,
  );
});
