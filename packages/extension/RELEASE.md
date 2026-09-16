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

Pre-release tags package the VSIX with `vsce --pre-release`. Upload that same file
with `ovsx publish <vsix>`: its CLI [ignores `--pre-release` for prepackaged files](https://github.com/eclipse-openvsx/openvsx/blob/main/cli/src/publish.ts),
and the server [reads `Microsoft.VisualStudio.Code.PreRelease` from the VSIX manifest](https://github.com/eclipse-openvsx/openvsx/blob/main/server/src/main/java/org/eclipse/openvsx/ExtensionProcessor.java).
No extra Open VSX publish flag is needed.

Every runtime file is named in `runtime-files.json`. Package verification fails if a
listed file, or a file `package.json` refers to, is missing from the VSIX, and if
`dist/`, `resources/` or `syntaxes/` contains a file the list does not name. Adding
or removing a runtime asset therefore means editing that list in the same change.

If either registry rejects a publish, the workflow records both registry
outcomes in its job summary and fails. A successful upload cannot be rolled
back; cut a follow-up version to repair a partial publish.
