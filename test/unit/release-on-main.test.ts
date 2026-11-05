import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error The installed YAML parser has no type declarations.
import { load } from 'js-yaml';

// spec:release#r-r15. The shape of the workflow that prepares, tags, publishes and syncs. What GitHub does with it (the
// pull requests, the approval, the token's rules) cannot be run here; these tests hold the file to the order, the
// permissions and the guards the rule asks for.
const read = (name: string) => readFileSync(join(import.meta.dirname, '../../.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');
const text = read('release-on-main.yml');

type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  secrets?: unknown;
  environment?: unknown;
};
const workflow = load(text) as {
  on: { push: { branches: string[] }; workflow_dispatch: { inputs: { dry_run: { type: string } } } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;

/** The text of one job, up to the next. */
function jobText(name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('R-R15 runs on main and by hand, one at a time and never cancelled, with no default permission', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.ok(workflow.concurrency.group);
  assert.deepEqual(workflow.permissions, {});
});

test('R-R15 a head commit that is a release or a sync does nothing, and a manual run only on main', () => {
  const guard = jobs.plan?.if ?? '';
  assert.match(guard, /!startsWith\(github\.event\.head_commit\.message, 'chore\(release\)'\)/);
  assert.match(guard, /!startsWith\(github\.event\.head_commit\.message, 'chore: sync version'\)/);
  assert.match(guard, /github\.ref == 'refs\/heads\/main'/);
});

test('R-R15 only prepare writes before publication; plan, publish and the secrets stay apart', () => {
  assert.deepEqual(jobs.plan?.permissions, { contents: 'read' });
  assert.deepEqual(jobs.prepare?.permissions, { contents: 'write', 'pull-requests': 'write' });
  // publish grants what release.yml's publish job asks for and no more; no secret is passed to it.
  assert.deepEqual(jobs.publish?.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(jobs.publish?.uses, './.github/workflows/release.yml');
  assert.equal(jobs.publish?.secrets, undefined);
  assert.equal(jobs.publish?.with?.tag, '${{ needs.prepare.outputs.tag }}');
  assert.deepEqual(jobs.release?.permissions, { contents: 'write' });
  assert.deepEqual(jobs.sync?.permissions, { contents: 'write', 'pull-requests': 'write' });
  for (const [name, definition] of Object.entries(jobs)) {
    assert.equal(definition.environment, undefined, `${name} names no environment: only release.yml's publish job does`);
    assert.ok(!jobText(name).replace(/#[^\n]*/g, '').includes('secrets.'), `${name} reads no secret`);
    if (name !== 'publish') assert.ok(!jobText(name).includes('id-token'), `${name} has no OIDC token`);
  }
});

test('R-R15 the order is plan, prepare, publish, release, sync; dry_run stops after plan; release needs a publish that started', () => {
  assert.match(jobs.prepare?.if ?? '', /needs\.plan\.outputs\.version != ''/);
  assert.match(jobs.prepare?.if ?? '', /!inputs\.dry_run/);
  assert.deepEqual(jobs.publish?.needs, ['plan', 'prepare']);
  assert.deepEqual(jobs.release?.needs, ['plan', 'prepare', 'publish']);
  assert.deepEqual(jobs.sync?.needs, ['plan', 'prepare', 'release']);
  const condition = jobs.release?.if ?? '';
  assert.match(condition, /needs\.publish\.outputs\.marketplace != ''/, 'a publish that never started leaves no GitHub release');
  assert.match(condition, /!cancelled\(\)/);
  // prepare builds on the commit plan validated, not on a main that moved.
  assert.match(jobText('prepare'), /ref: \$\{\{ needs\.plan\.outputs\.sha \}\}/);
});

test('R-R15 plan checks the notes before anything changes, and prepare tags only after the merge is confirmed', () => {
  const plan = jobText('plan');
  assert.match(plan, /plan --json/);
  assert.ok(plan.indexOf('release.mjs plan --json') < plan.indexOf('release.mjs check-next-notes'));
  assert.match(plan, /fetch-depth: 0/);
  const prepare = jobText('prepare');
  const at = (step: string) => prepare.indexOf(`- name: ${step}`);
  assert.ok(at('Refuse a stale release branch') < at('Set the version and create the release commit'));
  assert.ok(at('Open and merge the release pull request') < at('Wait until the release pull request is merged'));
  assert.ok(at('Wait until the release pull request is merged') < at('Push the tag on the release commit'));
  assert.match(prepare, /gh pr merge "\$number" --merge --subject "chore\(release\): \$VERSION"/);
  assert.match(prepare, /git commit -m "chore\(release\): \$VERSION"/);
  assert.match(prepare, /grep -vxF -e package\.json -e package-lock\.json -e release-notes\/next\.md -e "release-notes\/release-notes\.v\$VERSION\.md"/);
  assert.ok(!/--delete-branch/.test(text), 'the release branch stays as the mark of a release that was made');
});

test('R-R15 the sync pull request is titled and merged as chore: sync version, and lists the files that conflict', () => {
  const sync = jobText('sync');
  assert.match(sync, /--title "chore: sync version"/);
  assert.match(sync, /gh pr merge "\$number" --merge --subject "chore: sync version"/);
  assert.match(sync, /git merge-tree --write-tree --name-only/);
});

test('R-R15 release.yml keeps its tag trigger and its approval, and builds the tag it is given', () => {
  const release = read('release.yml');
  const parsed = load(release) as {
    on: { push: { tags: string[] }; workflow_call: { inputs: { tag: { required: boolean } } } };
    jobs: { publish: { environment: string; permissions: Record<string, string> } };
  };
  assert.deepEqual(parsed.on.push.tags, ['v[0-9]+.[0-9]+.[0-9]+']);
  assert.equal(parsed.on.workflow_call.inputs.tag.required, true);
  assert.equal(parsed.jobs.publish.environment, 'vscode-release');
  assert.deepEqual(parsed.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.match(release, /tag: \$\{\{ inputs\.tag \}\}/);
  const verify = read('verify.yml');
  assert.match(verify, /ref: \$\{\{ inputs\.tag && format\('refs\/tags\/\{0\}', inputs\.tag\) \|\| '' \}\}/);
  assert.match(verify, /REF_NAME: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.ok(!/github\.sha|GITHUB_SHA/.test(verify.replace(/#[^\n]*/g, '')), 'verify builds the commit it checked out, not the one the caller ran on');
});
