# Contributing

## Building a VSIX from the sibling checkouts

The pins and the sibling links are described in
[Development dependencies](packages/extension/README.md#development-dependencies).
This is how to build a VSIX from those checkouts and install it.

The sibling repositories sit next to this one:

```
dsl-kotlin
zenwave-lsp
zenwave-architectural-vistas
zenwave-platform-vscode
```

Prerequisites are Node and npm, pnpm, and the SDKMAN JDKs named in each
repository's `.sdkmanrc`. The sibling build reads those files and uses that JDK
when SDKMAN has it. `dsl-kotlin` needs Java `24.0.2-tem`. Java 25 breaks its
Gradle build, and the only message is `25.0.2`. `zenwave-lsp` needs Java
`21.0.9-tem`.

1. At the root of this repository, run `npm ci`.
2. In `zenwave-architectural-vistas`, run `pnpm install --frozen-lockfile`.
3. At the root of this repository, run `node packages/extension/scripts/build-siblings.mjs`.
4. Run `npm run package --workspace packages/extension`.

A `[siblings]` line that says `linked to ../...` is a sibling that was linked.
`from the registry` means that sibling was not built.

The VSIX is written to `packages/extension/<name>-<version>.vsix`, taking `name`
and `version` from `packages/extension/package.json`. At the current version
that file is `packages/extension/zenwave-platform-0.0.0.vsix`. Install it with:

```console
code --install-extension packages/extension/zenwave-platform-0.0.0.vsix
```

If the vistas build says `vite` is not recognized, `node_modules/.bin` is
missing there. Run `pnpm install --frozen-lockfile --force` in
`zenwave-architectural-vistas`. `ZENWAVE_USE_LOCAL_DEPENDENCIES=false` switches
back to the registry packages, as described in
[Development dependencies](packages/extension/README.md#development-dependencies).
