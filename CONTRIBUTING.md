# Contributing

## Development dependencies

`@zenwave360/dsl`, `@zenwave360/lsp-js` and
`@zenwave360/vistas-eventflow-webview` are pinned to published versions, so
`npm ci` works on a clean checkout. The build copies the server's two bundles
into `dist/server`, the diagram page into `dist/eventflow-webview` and the pinned
Mermaid bundle into `dist/preview-webview`, and checks the first two against
`zenwaveLanguageServer` and `zenwaveEventFlowWebview` in
`packages/extension/package.json`.

To work against your checkouts without publishing, keep the sibling repositories
next to this one. As with the composite builds of `zenwave-lsp`, a sibling that
exists and is built wins, and anything else comes from the registry. Every
install links them into `node_modules` and prints what it linked:

```console
npm run build:siblings   # builds dsl-kotlin, zenwave-lsp and zenwave-architectural-vistas, then links them
npm run link:siblings    # only links what is already built
```

Unlike Gradle, npm doesn't rebuild a sibling for you: a link shows what was built
last, so run `build:siblings` after changing one. To build against the pinned
versions, as CI does:

```console
ZENWAVE_USE_LOCAL_DEPENDENCIES=false npm ci
```

`npm run package` warns when the VSIX carries a sibling build, and refuses when
`ZENWAVE_RELEASE_TAG` or `ZENWAVE_RELEASE_CHANNEL` is set. `ZENWAVE_LSP_JS_DIR` and
`ZENWAVE_VISTAS_WEBVIEW_DIR` still point the build at another directory, and
there the version must match the pin.

## Building the VSIX a release ships

To try exactly what a pre-release would publish, build from the pinned versions,
with no sibling linked:

```console
ZENWAVE_USE_LOCAL_DEPENDENCIES=false npm ci
npm run build
npm run package --workspace packages/extension
```

The `[siblings]` lines of `npm ci` must all say `from the registry`.

## Building a VSIX from the sibling checkouts

The pins and the sibling links are described in
[Development dependencies](#development-dependencies).
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
[Development dependencies](#development-dependencies).
