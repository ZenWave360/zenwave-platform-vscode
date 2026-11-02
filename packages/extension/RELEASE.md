# Releasing

What each rule is and why is in `zenwave-specs/zenwave-platform-vscode/release.md` (R-R1 to R-R13) and decisions 0023 and 0024.
This file is how to work with the pipelines in `.github/workflows/`.

| Workflow | Starts on | Does |
| --- | --- | --- |
| `ci.yml` | a pull request, a push to `main` | `verify.yml` and nothing else. A pull request into `develop` is the dry run of the pre-release. |
| `verify.yml` | called by the others | The checks, the package, both smoke tests, and the verified VSIX as an artifact. No registry credential. |
| `pre-release.yml` | a push to `develop` that changes the extension | Verifies, and when `ZENWAVE_PUBLISH_PRERELEASE` is `true`, publishes a pre-release to both registries, tags `vX.Y.Z-pre` and creates the GitHub pre-release. |
| `release.yml` | a tag `vX.Y.Z` | Verifies, waits for the reviewer of `vscode-release`, publishes a stable release. |

## Versions and release notes

There is no odd and even minor. A pre-release takes the `major.minor` of the last stable release and the workflow's run
number as its patch: `0.0.57` before the first release, `0.1.58` after `v0.1.0`. The patch has no padding, because the
Marketplace refuses a leading zero. The version is raised only for a stable release, on `main`; `develop` gets it by
merging `main` back.

Release notes are files in `packages/extension/release-notes/`: `next.md` is what is on `develop`, and
`release-notes.vX.Y.Z.md` is the notes of each stable release. `CHANGELOG.md` is generated from them every time the
extension is packaged, in every channel, with their full text, highest version first, and is not committed. In a
pre-release `next.md` is the section of the stamped version and the date of the commit, and the GitHub pre-release has
the text of the file itself (`node scripts/release.mjs notes`), not a cut of the changelog. In a development package the
changelog puts it under a `## [Unreleased]` heading that the generator adds; do not write that heading in `next.md`. A
stable release's section is dated by its tag, or by the commit being built when the tag does not exist yet. `npm run
package` writes the file, so a clean checkout needs no step before it; building and the unit tests do not read it. The
`release-notes/` folder is not in the VSIX.

Packaging needs a git checkout with its tags: the dates of the changelog come from commits and tags, so a source archive
fails, and a clone made with `--depth 1 --no-tags` dates a stable release by the wrong commit. CI checks out the whole
history for that reason.

## A pre-release

Merge to `develop`. Nothing else: the version is `MAJOR.MINOR.<run number>`, stamped by the workflow in its own checkout
and never committed. The push publishes only when the repository variable `ZENWAVE_PUBLISH_PRERELEASE` is `true`.
When it is not, the run still verifies and ends green, and nothing is published: no registry, no tag and no GitHub
pre-release. The summary names the variable and the version that would have been published.

To turn publication on, set `ZENWAVE_PUBLISH_PRERELEASE` to `true` under Settings, Secrets and variables, Actions,
Variables, or:

```console
gh variable set ZENWAVE_PUBLISH_PRERELEASE --body true --repo ZenWave360/zenwave-platform-vscode
```

The next push to `develop` then publishes.

- Write what changed in `release-notes/next.md`. The file must exist; it may be empty, as it is right after a release.
- The manifest on `develop` holds the `major.minor` of the last stable tag (`0.0.0` before the first). After a stable
  release, merge `main` back into `develop`; until then the pipeline fails and says so, rather than publish below
  stable. The stamped version must also be above the highest stable tag.
- Do not rename `pre-release.yml`: the run number is the patch, and restarts for a new file name. If it must be renamed,
  raise the minor in the same commit.
- Only documentation (`docs/`, `.claude/`, `.github/` other than `pre-release.yml` and `verify.yml`, Markdown at the
  repository root) leaves `develop` without a publication.
- Two merges close together never publish at once; an older run waiting behind a running one is skipped for the newest.

To see exactly what a merge will publish, open the pull request into `develop`: `ci.yml` runs the same checks, stamp and
package, and uploads the VSIX. Its patch is that run's number, not the pre-release workflow's.

### Raising the `@zenwave360/*` pins

`@zenwave360/lsp-js` and `@zenwave360/vistas-eventflow-webview` are pinned to exact versions, in `package.json`, in the
`zenwaveLanguageServer` and `zenwaveEventFlowWebview` blocks, and in `package-lock.json`. To move both to what npm `next` is
now:

```console
npm run pins:raise              # --dry-run to look first; --include @zenwave360/dsl to raise that one too
```

It commits nothing. Review the diff, then `ZENWAVE_USE_LOCAL_DEPENDENCIES=false npm ci`, the tests, and commit: that
commit is what the pre-release workflow builds, and publishes when `ZENWAVE_PUBLISH_PRERELEASE` is `true`. The pipeline
refuses a tag, a range, `latest`, blocks that disagree with
`package.json`, a lockfile that disagrees, and linked sibling builds. A pin to a version npm does not have fails `npm ci`.

### When a registry refuses

A failure at one registry does not stop the other, and the run ends failed with what each did. A version cannot be
withdrawn, so the remedy is to run the failed jobs again: the registry that has the version skips it, the other publishes
it, and the tag and GitHub pre-release are updated, never duplicated.

## A stable release

1. Merge `develop` into `main`. Every `@zenwave360/*` must be at a stable version on `main` (set stable pins by hand;
   `npm run pins:raise` only moves to `next`), and `resources/sdk-plugin-catalogue.json` current
   (`npm run generate:sdk-catalogue --workspace packages/extension`).
2. Prepare the release, still on `main`:

   ```console
   npm run release:prepare --workspace packages/extension -- 0.2.0
   ```

   It sets the version in `package.json`, renames `next.md` to `release-notes.v0.2.0.md` and leaves an empty `next.md`.
   It refuses a version that is not above the highest stable tag, and a notes file that already exists. It commits
   nothing: read the notes, make sure neither the first heading nor the first line says "draft" and that there is at least
   one line that is not a heading, and commit the four files: `package.json`, `package-lock.json` (its entry for the
   extension), the new notes and the empty `next.md`.
3. Tag that commit `v0.2.0`, or create a GitHub release that creates the tag. A tag with a suffix such as `-pre` publishes
   nothing.
4. Approve the `publish` job when `vscode-release` asks. Nothing publishes before.
5. Merge `main` back into `develop`, so its manifest holds `0.2` and its pre-releases are above the release. If
   `develop` wrote to `next.md` after the merge to `main`, the merge conflicts there: `main` emptied the file, and
   `develop` still has the lines that are now in the release's notes. Keep only the lines `develop` added after that
   merge, and none of what is in `release-notes.v0.2.0.md`; keeping `develop`'s side whole would put the released notes
   into the next pre-release and the next stable release again.

The workflow refuses a tag that is not on `main`, differs from the manifest, has no release notes, empty notes or notes
whose first heading or first line says draft, a version not above every other stable tag, a version that already has a
`vX.Y.Z-pre` tag, a `next` dependency or an old catalogue. A
stable release is a new build from its own tag, never a promoted pre-release.

### A hotfix

Release it from `main` with a low patch: after `v0.1.0`, the next is `v0.1.1`, with `prepare` as above. Do not number
it high, such as `v0.1.1057`: VS Code installs the highest version, so a stable `0.1.1057` would sit above every later
pre-release of `0.1`, whose patch is the run number, and the pre-release channel could not be offered again until the next
minor. The pipeline fails a pre-release that would end below the highest stable tag. A low patch leaves the pre-releases
above it, so users on them stay where they are and users on stable get the fix.

## Credentials

The `verify` job never sees one. The `publish` job runs in the GitHub environment `vscode-prerelease` (limited to
`develop`) or `vscode-release` (limited to `v*` tags, with a reviewer). It never installs or runs anything the `verify`
job produced: it reads the VSIX, `release-info.json` and the notes as data, and checks the VSIX against `SHA256SUMS`. The
publishing tools are `@vscode/vsce` and `ovsx`, from `packages/extension/publish-tools`, a small private package with its
own lockfile, outside the workspaces and outside the VSIX. The job takes those two files from the commit
(`github.sha`) with a sparse `actions/checkout` before any step that holds a secret, because `verify` runs third-party
build code in its tree and a file it uploaded could choose what runs next to a token. It runs
`npm ci --ignore-scripts` there in a step with no secret, and the publishing steps run the installed binaries, never
`npx`. To change a tool or its version, edit that package and
its lock (`npm install --package-lock-only --ignore-scripts` in that directory); a unit test refuses a range, or a lock
entry without an integrity hash. `@vscode/vsce-sign`, the one dependency with an install script, is only called when
signing, which this pipeline does not do.

Each registry uses its secret (`VSCE_PAT`, `OVSX_PAT`) when the environment has one, and trusted publishing (`vsce --oidc`,
`ovsx --trusted-publishing`) when it has not, with no fallback between them. To move a registry to trusted publishing,
register the publisher at the registry and delete its secret from both environments; there is no workflow edit. Global
Azure DevOps tokens end on 2026-12-01. Open VSX needs the namespace owned and one active version first.

## What the package holds

Every runtime file is named in `runtime-files.json`. Package verification fails if a listed file, or a file `package.json`
refers to, is missing from the VSIX, and if `dist/`, `resources/` or `syntaxes/` contains a file the list does not name.
Adding or removing a runtime asset therefore means editing that list in the same change.

`npm run package` writes `CHANGELOG.md` from `release-notes/`, reads `ZENWAVE_RELEASE_TAG` (stable) or `ZENWAVE_RELEASE_CHANNEL=pre-release`, runs the rules in
`scripts/release-rules.mjs`, and flags a pre-release VSIX with `vsce --pre-release`. `ovsx` ignores that flag for a
prepackaged file: Open VSX reads `Microsoft.VisualStudio.Code.PreRelease` from the VSIX manifest, and `verify:vsix --channel`
checks it is there.

Tests of the rules are `test/unit/release-rules.test.ts`; the VSIX must contain `CHANGELOG.md`, with a section for its
version, and nothing from `release-notes/`.
