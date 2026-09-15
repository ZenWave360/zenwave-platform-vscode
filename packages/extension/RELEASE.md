# Releasing

Releases are produced only by `.github/workflows/ci.yml`. Before tagging:

1. Set `packages/extension/package.json` to the numeric version being released.
2. Move that version's entries from `[Unreleased]` in `CHANGELOG.md` to
   `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, then leave a new empty `[Unreleased]`
   section above it.
3. For stable releases, use an even minor version and tag
   `vMAJOR.MINOR.PATCH`. For opt-in pre-releases, use an odd minor version and
   tag `vMAJOR.MINOR.PATCH-pre`. The suffix is on the Git tag only: VS Code
   extension versions support `major.minor.patch`, not SemVer prerelease suffixes.

The workflow packages one VSIX, verifies its contents and reproducibility, and
uploads that exact file to the VS Code Marketplace and Open VSX. It expects the
repository secrets `VSCE_PAT` and `OVSX_PAT`. A maintainer with access to the
corresponding publisher accounts must own rotation of those secrets.

Put runtime files that are not bundled JavaScript under `resources/` or
`syntaxes/`. Package verification inventories both trees recursively and
requires every file to be present in the VSIX, so adding a runtime asset does
not require maintaining a second filename list.

If either registry rejects a publish, the workflow records both registry
outcomes in its job summary and fails. A successful upload cannot be rolled
back; cut a follow-up version to repair a partial publish.
