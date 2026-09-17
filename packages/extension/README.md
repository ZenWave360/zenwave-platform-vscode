# ZenWave Platform

Domain modeling, event storming and API design with **ZDL** and **ZFL**.

> **Early access, work in progress.**
> Feedback at [GitHub Discussions](https://github.com/ZenWave360/zenwave-sdk/discussions).

## ZDL — domain modeling and API design

[ZDL](https://zenwave360.github.io/docs/event-driven-design/zenwave-domain-language)
models what is inside a bounded context: aggregates, entities, services,
commands, events and APIs.

## ZFL — event storming and flow modeling

[ZFL](https://www.zenwave360.io/docs/event-driven-design/zenwave-flow-language/)
models business flows across bounded contexts — the textual counterpart of an
Event Storming board.

## Current features

- Syntax highlighting for ZDL and ZFL, in both desktop and browser VS Code
- ZenWave SDK plugin completion and hover help, backed by the installed SDK or a
  clearly marked shipped catalogue
- Run CodeLens actions for enabled ZDL plugin declarations in trusted desktop
  workspaces
- The ZenWave language server, shipped with the extension and run in both hosts
  (a Node process on the desktop, a Web Worker in the browser): diagnostics,
  hover, Go to Definition, document symbols and formatting for ZDL, ZFL and the
  workspace's architecture manifest, which is taken from
  `zenwave.workspace.manifest` or from `project-manifest` in
  `.zenwave/config.yml`. A status bar item shows whether language features are
  available and why not; **ZenWave: Restart Language Server** restarts it.

More is on the way; see the repository for what is planned.

## Development dependencies

`@zenwave360/dsl@1.9.0-SNAPSHOT` is not published to npm yet, so a clean
`npm install`/`npm ci` currently fails. Build the sibling `dsl-kotlin` repository
and link its generated package without changing this manifest's version-based
dependency:

```console
npm link --no-save --workspace packages/extension ../dsl-kotlin/build/js/packages/dsl-kotlin
```

Once that exact version is published, clean installs work without a manifest
change.

The language server, `@zenwave360/lsp-js@0.1.0-SNAPSHOT`, is not published
either. It is not a dependency of the extension: the build copies its two
bundles into `dist/server`, and the version it must be is pinned in
`package.json` under `zenwaveLanguageServer`. `npm run build` fails, naming
what to do, until it is available. Build `zenwave-lsp`
(`./gradlew :lsp-js:lspJsNpmPack`) and point the build at the unpacked package:

```console
export ZENWAVE_LSP_JS_DIR="$PWD/../zenwave-lsp/lsp-js/build/npm-package"   # absolute; run from the repository root
npm run build    # also npm run test:desktop, test:browser, run-in-browser, package
```

Installing the tarball without saving it also works, but only where npm can
resolve every other dependency — today it cannot, because
`@zenwave360/dsl@1.9.0-SNAPSHOT` is not on the registry either, so the
environment variable is the dependable route:

```console
npm install --no-save --workspace packages/extension ../zenwave-lsp/lsp-js/build/npm-pack/zenwave360-lsp-js-0.1.0-SNAPSHOT.tgz
```

## Replaces

This extension supersedes **ZDL VSCode** (`ZenWave360.zdl-vscode`). Uninstall the
old one after installing this.

## License

MIT
