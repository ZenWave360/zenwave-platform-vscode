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

More is on the way; see the repository for what is planned.

## Development dependency

`@zenwave360/dsl@1.9.0-SNAPSHOT` is not published to npm yet, so a clean
`npm install`/`npm ci` currently fails. Build the sibling `dsl-kotlin` repository
and link its generated package without changing this manifest's version-based
dependency:

```console
npm link --no-save --workspace packages/extension ../dsl-kotlin/build/js/packages/dsl-kotlin
```

Once that exact version is published, clean installs work without a manifest
change.

## Replaces

This extension supersedes **ZDL VSCode** (`ZenWave360.zdl-vscode`). Uninstall the
old one after installing this.

## License

MIT
