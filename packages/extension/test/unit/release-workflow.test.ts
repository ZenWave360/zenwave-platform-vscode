import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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

test('R-R10 verify:vsix checks the changelog of a channel build for the version section', () => {
  const script = read('../../scripts/verify-vsix.mjs');
  const channelBlock = script.slice(script.indexOf('if (channel) {'), script.indexOf('if (problems.length'));
  assert.match(channelBlock, /problems\.push\(\.\.\.changelogProblems\(archive, info\.version\)\)/);
});
