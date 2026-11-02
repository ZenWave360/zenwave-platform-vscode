import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error A build script without type declarations.
import { parseExtensionVersion } from '../../scripts/release-rules.mjs';

// The rules are tested as functions; these tests hold the workflow and the scripts to what the rules need to see.
const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, ...parts), 'utf8').replace(/\r\n/g, '\n');
const verify = read('../../../../.github/workflows/verify.yml');

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
  const text = read('../../../../.github/workflows/pre-release.yml');
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

const workflowDirectory = join(import.meta.dirname, '../../../../.github/workflows');
const VERSION_PATTERN = "version_re='^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'";
const VERSION_CHECK = '[[ ! "$VERSION" =~ $version_re ]]';
// Same rule as release-rules.mjs: one component is 0 or a number with no leading zero.
const shellRule = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

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

test('the shell version rule agrees with release-rules.mjs', () => {
  for (const version of ['0.0.0', '0.1.0', '0.1.58', '10.20.30', '01.2.3', '1.02.3', '1.2.03', '1.2.3-pre', 'v1.2.3', '', '1.2', '1.2.3 ', '1.2.3;id']) {
    assert.equal(shellRule.test(version), parseExtensionVersion(version) !== undefined, version);
  }
});

test('no --jq program interpolates the version, the tag or a GitHub expression', () => {
  const files = readdirSync(workflowDirectory).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length > 0);
  const programs = files.flatMap((file) => jqPrograms(read('../../../../.github/workflows', file)).map((program) => `${file}: ${program}`));
  assert.ok(programs.length > 0, 'the workflows do use --jq');
  const interpolated = programs.filter((program) => /\$VERSION(?![A-Za-z0-9_])|\$tag(?![A-Za-z0-9_])|\$\{\{/.test(program));
  assert.deepEqual(interpolated, []);
  const trace = job(read('../../../../.github/workflows/pre-release.yml'), 'trace');
  assert.ok(jqPrograms(trace).includes('.[] | select(.ref == $ENV.TAG_REF) | .object.sha'));
});

test('publish and trace check the version format before they use it', () => {
  for (const [file, name] of [
    ['pre-release.yml', 'publish'],
    ['pre-release.yml', 'trace'],
    ['release.yml', 'publish'],
  ] as const) {
    const body = job(read('../../../../.github/workflows', file), name);
    const label = `${file} ${name}`;
    assert.ok(body.includes(VERSION_PATTERN), `${label} uses the major.minor.patch rule`);
    const checkAt = body.indexOf(VERSION_CHECK);
    assert.notEqual(checkAt, -1, `${label} checks the version`);
    const firstUse = firstCodeOffset(body, '$VERSION');
    assert.equal(firstUse, checkAt + VERSION_CHECK.indexOf('$VERSION'), `${label} checks the version before using it`);
    assert.equal(body.indexOf('\n      - name:'), body.indexOf('\n      - name: Check the version is major.minor.patch\n'), `${label} checks the version at the start`);
    assert.match(body, /echo "::error::The version from verify is not major\.minor\.patch with no leading zeros, so this job stops\."\n\s+exit 1/);
  }
});
