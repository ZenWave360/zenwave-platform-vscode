# 008 — Tasks

## 1. Decide and obtain

- [ ] 1.1 Who owns the VS Code Marketplace publisher account, and the Open VSX
      namespace — the requirement cannot be met without both
- [ ] 1.2 Tokens held as repository secrets, with a note of who can rotate them
- [x] 1.3 The tag shape that marks a release, and how pre-releases are numbered

## 2. Continuous integration

- [x] 2.1 A workflow on push and pull request: install, typecheck, lint, build
- [x] 2.2 Build both bundles and fail if either is missing
- [x] 2.3 Assert the browser bundle reaches no Node API — the ESLint boundary
      rule is the first line, this is the second
- [ ] 2.4 Launch the desktop host and confirm the extension activates on a
      fixture
      Local `npm run test:desktop` passes; CI execution remains unavailable (no remote).
- [ ] 2.5 Launch the browser host through `@vscode/test-web` and confirm the same
      Local `npm run test:browser` passes; CI execution remains unavailable (no remote).
- [x] 2.6 Cache dependencies so the checks stay cheap enough to run always

## 3. Packaging

- [x] 3.1 Build the VSIX in CI, not locally
- [x] 3.2 Assert the package contains the runtime assets it needs — positively,
      by name, so a future asset that is forgotten fails the build —
      `runtime-files.json`, checked both ways by `scripts/vsix-contents.mjs`
- [x] 3.3 Assert it contains no source, test, fixture or development
      configuration
- [ ] 3.4 Install the built VSIX into a clean editor and confirm it activates
- [x] 3.5 Record the package's size, so growth from bundled renderers is visible
- [x] 3.6 Regenerate the shipped SDK plugin catalogue as part of cutting a
      release, and record which SDK release it came from

## 4. Release metadata

- [x] 4.1 Marketplace listing fields: categories, keywords, icon, repository,
      README as the listing body
- [x] 4.2 Record the commit a version was built from, somewhere a maintainer can
      recover it from an installed version
- [x] 4.3 `CHANGELOG.md` becomes the release notes for a version; agree how
      `[Unreleased]` is closed off at release time
- [x] 4.4 Confirm rebuilding a tagged commit produces the same extension

## 5. Publishing

- [x] 5.1 Publish to the VS Code Marketplace on a release tag
- [x] 5.2 Publish the same artifact to Open VSX
- [x] 5.3 Report a partial publish loudly — one registry succeeding and the other
      failing must not pass quietly
- [x] 5.4 Publish nothing when any check fails
- [x] 5.5 Pre-release publishing, on its own tag shape, to both registries

## 6. Verification

- [x] 6.1 A dry run end to end on a throwaway tag, publishing nowhere
- [ ] 6.2 A real pre-release, installed from each registry in a clean editor
- [ ] 6.3 Confirm a user on stable is not moved onto the pre-release
- [ ] 6.4 Confirm switching back to stable works
- [ ] 6.5 Break the browser bundle deliberately on a branch and confirm the
      release checks catch it
      Local probe on deleted branch `codex/browser-node-api-probe`: importing
      `node:fs` in `src/activate.ts` makes `npm run build` exit 1 with the browser
      Node API diagnostic (`tmp/browser-node-api-probe.log`); CI evidence still needed.
- [x] 6.6 Remove a runtime asset deliberately and confirm packaging catches it
      (removed from the build and from the package; unit-tested in
      `test/unit/vsix-contents.test.ts`)
- [x] 6.7 `openspec validate 008-release --strict`

## 7. Archive

- [ ] 7.1 `openspec archive 008-release`
