# Project context

## What this is

**ZenWave Platform for VS Code** — the VS Code client for the ZenWave Platform's
modelling languages, **ZDL** (domain modelling and API design, inside a bounded
context) and **ZFL** (event-storming flow modelling, across bounded contexts).

It supersedes [`zdl-vscode`](https://github.com/ZenWave360/zdl-vscode) and is the
sibling of the IntelliJ plugin
[`ZenWaveDomainModelEditor`](https://github.com/ZenWave360/ZenWaveDomainModelEditor).
The two IDE clients should converge on the same behaviour; where they differ, it
should be because the host platform forced it, not by accident.

## Ownership boundaries (upstream, all work-in-progress)

These are other people's repos as far as this one is concerned. We consume them;
we do not reimplement them.

| Release | Owns |
| --- | --- |
| **zenwave-manifest** | `manifest-core`, `manifest-graph`, `workspace-runtime`, MCP adapter, **all architectural semantics** |
| **zenwave-lsp** | LSP mapping, document/language services, JVM + JS transports, IntelliJ and VS Code clients |
| **zenwave-architectural-vistas** | Visualization packages under the `@zenwave360` scope — `vistas-eventflow` (EventFlow and Service Map renderers, view-model contracts), `eventcatalog-components`, and the webview bundle both IDE plugins embed |

The consequence for this repo: **if a question is about what a model *means*, or
about how a diagram is *drawn*, the answer lives upstream.** This repo is
responsible for how that meaning is *presented and driven* inside VS Code.

## Architectural decisions

These were settled at project start. Revisit them with a change proposal, not in
passing.

### Kotlin Multiplatform is the engine; TypeScript is the shell

The language stack (`dsl-kotlin`, `manifest-core`, `lsp-core`) is Kotlin
Multiplatform with a JS target. We lean on that rather than reimplementing
parsing or semantics in TypeScript.

This is already proven, not aspirational: **`@zenwave360/dsl` is a published
Kotlin/JS npm package** exposing `parseZdl` / `parseZfl` as an ES module with
pure-JS dependencies, and `zdl-vscode` consumed it successfully in the browser.
`@zenwave360/lsp-js` is the same pattern applied to the language server, and is
currently a stub in `zenwave-lsp/lsp-js`.

### Web compatibility is a first-class target, not a stretch goal

The extension ships both a Node extension host entry and a browser (Web Worker)
entry. Everything that *can* work in the browser *must*.

**But it cannot be universal, and pretending otherwise would be dishonest:**
`zenwave-sdk` is JVM-only and runs from the CLI via JBang. Code generation
therefore cannot work in vscode.dev, ever. Features are gated on host
capabilities rather than silently failing.

> Known upstream gap: `lsp-js` currently declares only a `nodejs()` Kotlin/JS
> target. Running a language server in the VS Code **web** host requires a Web
> Worker and `vscode-languageserver/browser`'s `BrowserMessageReader/Writer`.
> A browser-safe target (or at minimum, avoidance of Node-only APIs plus browser
> message transports) is needed in `zenwave-lsp` before web LSP can work.

### Monorepo with npm workspaces

`packages/extension` is the VS Code client. `packages/preview-renderer` is a
rendering package that builds to a bundle the IntelliJ plugin could also consume.

**EventFlow is not one of our packages.** An earlier version of this document
said we would vendor `zenwave-eventflow` here as `packages/eventflow-ui`. That
was wrong, and was written before we looked at
[`zenwave-architectural-vistas`](../../zenwave-architectural-vistas/REPOSITORY_SCOPE.md):
the extraction had *already happened* there, as `@zenwave360/vistas-eventflow`,
with its own npm scope, changesets releases, and a `pnpm sync:intellij` script
that pushes the webview bundle into
`ZenWaveDomainModelEditor/src/main/resources/web/eventflow/`.

Vendoring it here would have created a third copy and broken that repository's
stated dependency rule — *"Visualization packages must not depend on EventCatalog,
the ZenWave website, or the IntelliJ plugin."* We consume, we do not copy.

### Mermaid, not PlantUML

Diagrams in previews are emitted as Mermaid and rendered with a bundled Mermaid
library. PlantUML requires either a JVM or a remote rendering server; the first
is impossible in the browser and the second sends the user's domain model to a
third party by default. The cost is porting IntelliJ's PlantUML class-diagram
templates to Mermaid.

### The SDK runner uses the VS Code Tasks API

Not raw `terminal.sendText`. A `ShellExecution` task gives a real terminal (which
is what IntelliJ users expect) *plus* exit codes, cancellation, problem matchers
and user-rebindable re-runs.

### Preview rendering: TypeScript now, Kotlin later

The Handlebars renderer ported from `zdl-vscode` goes behind a `PreviewProvider`
interface, so an LSP-backed provider can replace it once `lsp-core` grows a
`zenwave/preview` capability — at which point IntelliJ and VS Code render
identically from one Kotlin implementation. Specify the interface; do not let
Handlebars templates leak across it.

### Identity

Ships as a **new marketplace extension**, `ZenWave360.zenwave-platform`.
`ZenWave360.zdl-vscode` gets deprecated with a pointer to the successor.
Existing users migrate manually.

## Capability map

Capabilities appear in `specs/` as their changes are archived.

| Capability | Status | What it covers |
| --- | --- | --- |
| `host-capabilities` | change 001 | Detecting what the current host can do; gating features honestly |
| `languages` | change 001 | ZDL/ZFL file association, syntax highlighting, editor configuration |
| `lsp-client` | planned | Launching and talking to the language server over the right transport |
| `markdown-preview` | planned | Side-by-side ZDL/ZFL preview with Mermaid diagrams |
| `sdk-runner` | planned | CodeLens on plugin declarations; building and running the CLI command |
| `eventflow-panel` | planned | Hosting the upstream `@zenwave360/vistas-eventflow` webview as a ZFL flow diagram panel, and feeding it a view model |

## Conventions

- **Language:** TypeScript, `strict`, no `any` at module boundaries.
- **Bundler:** esbuild, two targets — `dist/node/extension.js` (platform `node`)
  and `dist/browser/extension.js` (platform `browser`, format `cjs` for the
  worker host).
- **Command ids:** `zenwave.<area>.<verb>` — e.g. `zenwave.preview.open`.
- **Settings keys:** `zenwave.<area>.<setting>`.
- **Context keys:** `zenwave.<capability>Available`, for `when` clauses in
  `package.json` contributions.
- **Never** call a Node API from code reachable by the browser entry. The shared
  `activate()` receives its host services by injection.
