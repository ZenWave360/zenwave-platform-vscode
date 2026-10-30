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
- An EventFlow diagram for ZFL flows, drawn by the same renderer the IntelliJ
  plugin embeds: from the ZenWave icon in a flow's editor title bar, open it
  beside the text or in its place (**Reopen Editor With…** or **Show ZFL Text**
  goes back). The diagram follows edits as you type, keeps the last diagram on
  screen while the flow cannot be read, and switches between the flow and
  service views and humanized labels from its own title bar
  (`zenwave.eventflow.defaultView`, `zenwave.eventflow.humanizeLabels` set how it
  opens). When it has nothing to draw it says why. Clicking a node does not
  navigate to its source yet.
- A preview of ZDL and ZFL models, drawn from what the language server returns
  with the Mermaid renderer shipped in the extension (no network): from the
  ZenWave icon in the editor title bar, or **ZenWave: Open Preview**
  (`Ctrl+Shift+V`) and **Open Preview to the Side** (`Ctrl+K V`). A ZDL model shows
  its class diagram; a ZFL flow shows its flowchart and one sequence per outcome,
  with selectors for the diagram and for how sequence variants are rendered. It
  follows edits as you type, keeps the last good drawing while the model cannot be
  read, follows the colour theme, and says why when it has nothing to show.
  Opening a model file still gives its text.

More is on the way; see the repository for what is planned.

## Development dependencies

`@zenwave360/dsl`, `@zenwave360/lsp-js` and
`@zenwave360/vistas-eventflow-webview` are pinned to published versions, so
`npm ci` works on a clean checkout. The build copies the server's two bundles
into `dist/server`, the diagram page into `dist/eventflow-webview` and the pinned
Mermaid bundle into `dist/preview-webview`, and checks the first two against `zenwaveLanguageServer` and `zenwaveEventFlowWebview` in
`package.json`.

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
`ZENWAVE_RELEASE_TAG` is set. `ZENWAVE_LSP_JS_DIR` and
`ZENWAVE_VISTAS_WEBVIEW_DIR` still point the build at another directory, and
there the version must match the pin.

## Replaces

This extension supersedes **ZDL VSCode** (`ZenWave360.zdl-vscode`). Uninstall the
old one after installing this.

## License

MIT
