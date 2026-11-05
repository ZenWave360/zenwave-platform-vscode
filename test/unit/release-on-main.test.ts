import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error The installed YAML parser has no type declarations.
import { load } from 'js-yaml';

// spec:release#r-r15. The shape of the workflows that prepare, tag, publish and sync. What GitHub does with them (the pull
// requests, the dispatch, the approval, the token's rules) cannot be run here; these tests hold the files to the order, the
// permissions and the guards the rule asks for.
const read = (name: string) => readFileSync(join(import.meta.dirname, '../../.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');

type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  uses?: string;
  secrets?: unknown;
  environment?: unknown;
};
type Workflow = { on: Record<string, unknown>; concurrency?: { group: string; 'cancel-in-progress': boolean }; permissions: Record<string, string>; jobs: Record<string, Job> };

const mainText = read('release-on-main.yml');
const releaseText = read('release.yml');
const preText = read('pre-release.yml');
const main = load(mainText) as Workflow;
const release = load(releaseText) as Workflow;
const pre = load(preText) as Workflow;

/** The text of one job, up to the next. */
function jobText(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}
const code = (text: string) => text.replace(/#[^\n]*/g, '');

test('R-R15 release-on-main runs on main and by hand, one at a time and never cancelled, with no default permission', () => {
  assert.deepEqual((main.on.push as { branches: string[] }).branches, ['main']);
  assert.equal((main.on.workflow_dispatch as { inputs: { dry_run: { type: string } } }).inputs.dry_run.type, 'boolean');
  assert.equal(main.concurrency?.['cancel-in-progress'], false);
  assert.ok(main.concurrency?.group);
  assert.deepEqual(main.permissions, {});
  assert.deepEqual(Object.keys(main.jobs), ['plan', 'prepare', 'dispatch']);
});

test('R-R15 a release or sync head commit does nothing, for a push and for a manual run', () => {
  const guard = main.jobs.plan?.if ?? '';
  assert.match(guard, /!startsWith\(github\.event\.head_commit\.message, 'chore\(release\)'\)/);
  assert.match(guard, /!startsWith\(github\.event\.head_commit\.message, 'chore: sync version'\)/);
  assert.match(guard, /github\.ref == 'refs\/heads\/main'/);
  // A manual run has no head commit in the event: the subject of the head that was checked out is read.
  const plan = jobText(mainText, 'plan');
  assert.match(plan, /subject=\$\(git log -1 --format=%s "\$sha"\)/);
  assert.match(plan, /'chore\(release\)'\* \| 'chore: sync version'\*\)/);
});

test('R-R15 plan reads the current head of main and passes that sha on, not github.sha', () => {
  const plan = jobText(mainText, 'plan');
  assert.match(plan, /ref: main\n/);
  assert.match(plan, /git fetch --quiet origin main\n\s+sha=\$\(git rev-parse origin\/main\)/);
  assert.ok(!/github\.sha/.test(code(mainText)));
  assert.match(jobText(mainText, 'prepare'), /ref: \$\{\{ needs\.plan\.outputs\.sha \}\}/);
});

test('R-R15 only prepare writes before publication, dispatch only starts a workflow, and no secret is read', () => {
  assert.deepEqual(main.jobs.plan?.permissions, { contents: 'read' });
  assert.deepEqual(main.jobs.prepare?.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.deepEqual(main.jobs.dispatch?.permissions, { actions: 'write' });
  for (const name of Object.keys(main.jobs)) {
    const job = main.jobs[name];
    assert.equal(job?.uses, undefined, `${name} calls no reusable workflow: the environment of a called job would see main, not the tag`);
    assert.equal(job?.environment, undefined);
    assert.ok(!code(jobText(mainText, name)).includes('secrets.'), `${name} reads no secret`);
    assert.ok(!jobText(mainText, name).includes('id-token'), `${name} has no OIDC token`);
  }
  assert.ok(!/workflow_call/.test(releaseText) && !/workflow_call/.test(read('verify.yml').replace(/on:\n {2}workflow_call:/, '')));
});

test('R-R15 dry_run stops after plan, and the order inside prepare keeps the tag for last', () => {
  assert.match(main.jobs.prepare?.if ?? '', /needs\.plan\.outputs\.version != ''/);
  assert.match(main.jobs.prepare?.if ?? '', /!inputs\.dry_run/);
  assert.deepEqual(main.jobs.dispatch?.needs, ['plan', 'prepare']);
  const plan = jobText(mainText, 'plan');
  assert.ok(plan.indexOf('release.mjs plan --json') < plan.indexOf('release.mjs check-next-notes'));
  assert.match(plan, /fetch-depth: 0/);
  const prepare = jobText(mainText, 'prepare');
  const at = (step: string) => prepare.indexOf(`- name: ${step}`);
  assert.ok(at('Resume this run') < at('Set the version and create the release commit'));
  assert.ok(at('Open and merge the release pull request') < at('Wait until the release pull request is merged'));
  assert.ok(at('Wait until the release pull request is merged') < at('Push the tag on the release commit'));
  assert.match(prepare, /gh pr merge "\$number" --merge --subject "chore\(release\): \$VERSION"/);
  assert.match(prepare, /git commit -m "chore\(release\): \$VERSION"/);
  assert.match(prepare, /grep -vxF -e package\.json -e package-lock\.json -e release-notes\/next\.md -e "release-notes\/release-notes\.v\$VERSION\.md"/);
  assert.ok(!/--delete-branch/.test(mainText), 'the release branch stays as the mark of a release that was made');
});

test('R-R15 a re-run of the same run resumes its release branch, and any other existing branch fails', () => {
  const prepare = jobText(mainText, 'prepare');
  assert.match(prepare, /\[ "\$subject" = "chore\(release\): \$VERSION" \] && \[ "\$parents" = "\$PLAN_SHA" \]/);
  assert.match(prepare, /already exists on origin and is not the release commit of this run/);
  // The commit and the push are skipped on a resume; the pull request and the tag are looked up, not created twice.
  assert.equal(prepare.split("if: steps.branch.outputs.release_sha == ''").length, 3);
  assert.match(prepare, /gh pr list --base main --head "release\/\$VERSION" --state all/);
  assert.match(prepare, /existing=\$\(gh api "repos\/\$GH_REPO\/git\/matching-refs\/tags\/\$TAG"/);
});

test('R-R15 dispatch starts release.yml on the tag, which is what the tag-only environment needs', () => {
  const dispatch = jobText(mainText, 'dispatch');
  assert.match(dispatch, /gh workflow run release\.yml --ref "v\$VERSION"/);
  assert.match(dispatch, /gh run list --workflow release\.yml --branch "v\$VERSION"/);
});

test('R-R15 release.yml also runs by hand on a tag, publishes only with the approval, and then releases and syncs', () => {
  assert.deepEqual((release.on.push as { tags: string[] }).tags, ['v[0-9]+.[0-9]+.[0-9]+']);
  assert.ok('workflow_dispatch' in release.on);
  assert.equal(release.jobs.verify?.if, "github.ref_type == 'tag'");
  assert.equal(release.jobs.publish?.environment, 'vscode-release');
  assert.deepEqual(release.jobs.publish?.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(release.jobs.release?.needs, ['verify', 'publish']);
  assert.deepEqual(release.jobs.release?.permissions, { contents: 'write' });
  // A publish that never started leaves no registry output, so no GitHub release follows a refused approval.
  assert.match(release.jobs.release?.if ?? '', /needs\.publish\.outputs\.marketplace != ''/);
  assert.match(release.jobs.release?.if ?? '', /!cancelled\(\)/);
  assert.deepEqual(release.jobs.sync?.needs, ['verify', 'release']);
  assert.deepEqual(release.jobs.sync?.permissions, { contents: 'write', 'pull-requests': 'write', actions: 'write' });
  for (const name of ['verify', 'release', 'sync']) assert.ok(!code(jobText(releaseText, name)).includes('secrets.'));
  assert.ok(code(jobText(releaseText, 'publish')).includes('secrets.VSCE_PAT'));
  // The tools come from the commit of the run, which is the tag's.
  assert.match(jobText(releaseText, 'publish'), /ref: \$\{\{ github\.sha \}\}/);
});

test('R-R15 sync is titled and merged as chore: sync version, lists the files that conflict, and asks for a pre-release on develop', () => {
  const sync = jobText(releaseText, 'sync');
  assert.match(sync, /--title "chore: sync version"/);
  assert.match(sync, /gh pr merge "\$number" --merge --subject "chore: sync version"/);
  assert.match(sync, /git merge-tree --write-tree --name-only/);
  assert.match(sync, /sync\/\$VERSION/);
  assert.match(sync, /gh pr list --base develop --head "\$head" --state open/);
  assert.match(sync, /gh workflow run pre-release\.yml --ref develop/);
});

test('R-R15 pre-release.yml accepts a dispatch on develop and runs nothing for another ref', () => {
  assert.ok('workflow_dispatch' in pre.on);
  assert.equal(pre.jobs.verify?.if, "github.ref == 'refs/heads/develop'");
});
