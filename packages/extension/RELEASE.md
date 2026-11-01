# Releasing

What each rule is and why is in `zenwave-specs/zenwave-platform-vscode/release.md` (R-R1 to R-R13) and decision 0023.
This file is how to work with the pipelines in `.github/workflows/`.

| Workflow | Starts on | Does |
| --- | --- | --- |
| `ci.yml` | a pull request, a push to `main` | `verify.yml` and nothing else. A pull request into `develop` is the dry run of the pre-release. |
| `verify.yml` | called by the others | The checks, the package, both smoke tests, and the verified VSIX as an artifact. No registry credential. |
| `pre-release.yml` | a push to `develop` that changes the extension | Verifies, publishes a pre-release to both registries, tags `vX.ODD.Z-pre` and creates the GitHub pre-release. |
| `release.yml` | a tag `vX.EVEN.Z` | Verifies, waits for the reviewer of `vscode-release`, publishes a stable release. |

## A pre-release

Merge to `develop`. Nothing else: the version is `MAJOR.MINOR.<run number>`, stamped by the workflow in its own checkout,
and `## [Unreleased]` in `CHANGELOG.md` becomes that version's section there. Neither is committed.

- The manifest on `develop` holds an **odd minor**, and above the latest stable release. After `v0.2.0`, move `develop` to
  `0.3.0` in a commit of its own, or the pipeline fails rather than publish below stable.
- Keep `## [Unreleased]` in `CHANGELOG.md`; the pipeline fails without it. It is the release notes.
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
commit is what publishes the pre-release. The pipeline refuses a tag, a range, `latest`, blocks that disagree with
`package.json`, a lockfile that disagrees, and linked sibling builds. A pin to a version npm does not have fails `npm ci`.

### When a registry refuses

A failure at one registry does not stop the other, and the run ends failed with what each did. A version cannot be
withdrawn, so the remedy is to run the failed jobs again: the registry that has the version skips it, the other publishes
it, and the tag and GitHub pre-release are updated, never duplicated.

## A stable release

1. On `main`: an **even minor** in `packages/extension/package.json`, every `@zenwave360/*` at a stable version (run
   `npm run pins:raise` only for `next`; set stable pins by hand), `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`, and
   `resources/sdk-plugin-catalogue.json` current (`npm run generate:sdk-catalogue --workspace packages/extension`).
2. Tag that commit `vX.Y.Z`, or create a GitHub release that creates the tag. A tag with a suffix such as `-pre` publishes
   nothing.
3. Approve the `publish` job when `vscode-release` asks. Nothing publishes before.
4. Afterwards move `develop` to the next odd minor.

The workflow refuses a tag that is not on `main`, differs from the manifest, has no changelog section, has a `next`
dependency or an old catalogue. A stable release is a new build from its own tag, never a promoted pre-release.

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

`npm run package` reads `ZENWAVE_RELEASE_TAG` (stable) or `ZENWAVE_RELEASE_CHANNEL=pre-release`, runs the rules in
`scripts/release-rules.mjs`, and flags a pre-release VSIX with `vsce --pre-release`. `ovsx` ignores that flag for a
prepackaged file: Open VSX reads `Microsoft.VisualStudio.Code.PreRelease` from the VSIX manifest, and `verify:vsix --channel`
checks it is there.

Tests of the rules are `test/unit/release-rules.test.ts`.
