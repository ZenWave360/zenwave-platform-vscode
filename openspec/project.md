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
| **zenwave-architecture** | `manifest-core`, `manifest-graph`, `workspace-runtime`, MCP adapter, **all architectural semantics** |
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

The intent is that `ZenWave360.zdl-vscode` is eventually deprecated with a
pointer to the successor, and that existing users migrate manually. **How that
happens is not settled and is not scheduled** — the predecessor contributes the
same language ids, so what a user with both installed experiences is a real
question that `008-release` explicitly defers. Treat the deprecation as an
intention, not as specified behaviour.

## Capability map

Capabilities appear in `specs/` as their changes are archived.

| Capability | Status | What it covers |
| --- | --- | --- |
| `host-capabilities` | change 001 | Detecting what the current host can do; gating features honestly |
| `languages` | change 001 | ZDL/ZFL file association, syntax highlighting, editor configuration |
| `sdk-runner` | change 002 | CodeLens on plugin declarations; building and running the CLI command |
| `lsp-client` | change 003 | Launching and talking to the language server over the right transport |
| `eventflow-panel` | change 004 | Hosting the upstream `@zenwave360/vistas-eventflow` webview as a ZFL flow diagram panel, and feeding it a view model |
| `model-preview` | change 005 | Side-by-side ZDL/ZFL preview of the server's representations, with Mermaid diagrams |
| `model-explorer` | change 006 | Architecture and model hierarchy trees in a ZenWave sidebar container |
| `model-actions` | change 007 | Server-backed commands on a model: semantic navigation, organising ZFL services |
| `release` | change 008 | Building, versioning and publishing to the VS Code Marketplace and Open VSX |

**What is actually startable.** Only `008` — the release pipeline depends on
nothing. `002` was classified as ready and is not: `@zenwave360/dsl` is not on
the npm registry, so the extension cannot declare the dependency it is built on.
`003` to `007` are blocked on `zenwave-lsp`, and several of them on upstream
behaviour that an adversarial review of these specs showed was assumed rather
than real — hierarchy for an unopened document, nodes that point at the document
declaring them, a position-to-symbol step, matching a tree node to a diagram
node, and configuration changes taken up without a restart. Each change's
proposal says which of these it waits on.

**A note on how these specs were written.** Much of the upstream behaviour here
was established by reading Kotlin, and several claims that entered the specs as
fact were inferences that turned out to be false — a planning document read as a
description of what exists, an identifier assumed to be shared between two
subsystems, a request assumed to compose with another. `openspec validate
--strict` caught none of them; a fresh reader checking the claims against the
code caught all of them. Verify against the implementation before building on a
statement about upstream, including the ones in these documents.
The cross-repo contracts they need are proposed in the shared store as
`001-ide-client-contracts`.

The preview (005) and the EventFlow diagram (004) are both **custom editors**, so
a model file can be opened as text, as a preview or as a diagram. The trees in
006 live in their own activity-bar container. Two consequences worth knowing
before writing code against any of them: `window.activeTextEditor` is undefined
whenever one of those editors has focus, so the active document is resolved
through `window.tabGroups`; and the server/client division flips between them —
view models and preview representations are rendered as the server describes
them, while hierarchy nodes are presented in this client's own idiom.

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
