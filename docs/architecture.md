# Architecture

How the pieces fit, and which repository owns what. For *behaviour*, read
`openspec/specs/`; this document describes structure, which specs deliberately
do not.

## The stack

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code                                                      │
│  ┌────────────────────────┐  ┌────────────────────────────┐  │
│  │ Node extension host    │  │ Web Worker extension host  │  │
│  │ dist/node/extension.js │  │ dist/browser/extension.js  │  │
│  └───────────┬────────────┘  └─────────────┬──────────────┘  │
│              └──────────┬──────────────────┘                 │
│                    src/activate.ts  (host-agnostic)          │
└──────────────────────────┬───────────────────────────────────┘
                           │
         ┌─────────────────┼──────────────────┐
         │                 │                  │
   @zenwave360/dsl   @zenwave360/lsp-js   zenwave-sdk
   (Kotlin/JS)       (Kotlin/JS)          (JVM via JBang)
   parse ZDL/ZFL     language server      code generation
   desktop + web     desktop + web        DESKTOP ONLY
```

## Kotlin Multiplatform is the engine

The language stack is Kotlin Multiplatform with a JS target, and we consume its
JS artefacts rather than reimplementing parsing or semantics in TypeScript.

This is proven rather than aspirational: **`@zenwave360/dsl` is a published
Kotlin/JS npm package** (from `dsl-kotlin`) exposing `parseZdl` / `parseZfl` as
an ES module with pure-JS dependencies, and `zdl-vscode` already consumed it
successfully inside the browser extension host.

`@zenwave360/lsp-js` applies the same pattern to the language server. It ships
two self-contained bundles, a Node entry spoken to over child-process IPC and a
classic Web Worker script using `BrowserMessageReader` / `BrowserMessageWriter`.
The build copies both into `dist/server`; the extension does not `require` the
package.

## The language server connection

```
src/node/extension.ts ── NodeLanguageServerHost ──┐   vscode-languageclient/node, fork + IPC
src/browser/extension.ts ─ WorkerLanguageServerHost ┤   vscode-languageclient/browser, new Worker
                                                   ▼
src/lsp/feature.ts     trust, settings, manifest, status bar, context keys, commands
src/lsp/supervisor.ts  one lifecycle; requests answer ok | no-server | unsupported | failed
src/lsp/requests.ts    typed zenwave/* wrappers for feature code
src/lsp/manifest*.ts   setting → .zenwave/config.yml → none, through vscode.workspace.fs
src/lsp/credential*.ts origin-matched answers to zenwave/credential
src/model/actions.ts   editor commands over zenwave/* requests (references, organize)
src/model/navigation.ts opens server locations (uri + range) the editor's way
src/explorer/*          Architecture and Model trees over zenwave/hierarchy; DiagramPanels seam for 004
src/eventflow/*         EventFlow diagram custom editor: hosts the vistas page, relays eventFlowViews verbatim
src/model/active-document.ts  the model document in the active tab (text or custom editor)
```

Shared code imports only *types* from `vscode-languageclient`: its bare entry is
the Node build. Each host entry supplies a `LanguageServerHost` that finds its
server and constructs the client with its own sub-path, and ESLint enforces who
may import which.

Feature code reaches the server only through the `LanguageServerApi` that
`activate` returns (`requests`, `status`, `onDidChange`, `manifest`). A request
never throws and never hangs: absence of a server, an unadvertised request and a
failed request are different answers, because they are different things to tell
the user.

## Two hosts, one activation

`src/node/extension.ts` and `src/browser/extension.ts` exist only to construct
host-specific services and call the shared `activate()`. No feature logic lives
in them.

The failure mode this prevents is subtle and expensive: a Node API reached
*transitively* from shared code. esbuild bundles it happily for
`platform: browser`, and it fails at runtime inside a Web Worker where stack
traces are unhelpful. Confining the Node surface to one file the browser bundle
never imports makes that a structural impossibility rather than a matter of
remembering.

Capabilities are therefore established **by construction** — the Node entry knows
it is Node — not by sniffing `vscode.env` from shared code.

## Capability gating

`HostCapabilities` (`src/host/capabilities.ts`) is injected into activation and
mirrored into context keys (`zenwave.canRunSdk`, `zenwave.canUseTerminal`) so
`package.json` `when` clauses can hide controls.

Context keys hide; they do not secure. Commands must re-check capabilities when
they execute, because the palette is not the only way to invoke one.

**Why hide rather than degrade:** in the browser, `zenwave-sdk` is not
temporarily unavailable, it is permanently unavailable. A control that can never
succeed teaches the user that the extension is broken. Where something is only
*partially* available, degrade instead — that is a per-feature judgement.

Because gating makes features silently absent, activation always logs the
detected capabilities to the ZenWave output channel. That log is the only way a
user can tell "not supported here" from "installed wrong".

## Rendering decisions

**Mermaid, not PlantUML.** PlantUML needs either a JVM (impossible in a browser)
or a remote rendering server (sends the user's domain model to a third party by
default). Mermaid bundles and runs identically in both hosts. The cost is porting
IntelliJ's PlantUML class-diagram templates.

**Preview rendering: TypeScript now, Kotlin later.** The Handlebars renderer
ported from `zdl-vscode` sits behind a `PreviewProvider` interface so an
LSP-backed provider can replace it once `lsp-core` grows a `zenwave/preview`
capability — at which point IntelliJ and VS Code render from one Kotlin
implementation. The interface is the deliverable; Handlebars must not leak across
it.

> Note: `zdl-vscode` rendered its preview into a virtual document consumed by
> VS Code's built-in Markdown preview. That built-in preview does **not** render
> Mermaid without a third-party extension, so the Mermaid decision implies an
> owned webview rather than reusing the built-in one. This is for the
> `markdown-preview` change to settle.

**SDK runner via the Tasks API**, not raw `terminal.sendText`. A `ShellExecution`
task gives the real terminal IntelliJ users expect *plus* exit codes,
cancellation, problem matchers and re-runnable tasks. IntelliJ's
`ZenWaveSDKTerminalRunner` reuses a terminal per working directory; the VS Code
equivalent is task identity.

## Repository ownership

All three upstreams are work in progress. If a question is about what a model
*means*, or how a diagram is *drawn*, the answer is upstream.

| Release | Owns |
| --- | --- |
| **zenwave-architecture** | `architecture-manifest`, `architecture-graph`, `workspace-runtime`, MCP adapter, all architectural semantics |
| **zenwave-lsp** | LSP mapping, document/language services, JVM + JS transports, IntelliJ and VS Code clients |
| **zenwave-architectural-vistas** | `@zenwave360/vistas-eventflow` and the other visualization packages, plus the webview bundle both IDE plugins embed |

## EventFlow comes from upstream

`ZenWaveDomainModelEditor` embeds a prebuilt EventFlow bundle at
`src/main/resources/web/eventflow/assets/`. That bundle is **not** hand-copied
and it is **not** ours to produce — it is generated and synced by
`zenwave-architectural-vistas`:

```
packages/eventflow        @zenwave360/vistas-eventflow   React renderers + view-model contracts
apps/eventflow-webview    private Vite app               builds the static webview bundle
scripts/sync-eventflow-webview.mjs                       pnpm sync:intellij → the plugin's resources
```

That repository's scope document names the VS Code plugin as a consumer of the
same bundle, and forbids the reverse dependency: *"Visualization packages must
not depend on EventCatalog, the ZenWave website, or the IntelliJ plugin."*

So the `eventflow-panel` capability is about **hosting** that webview and feeding
it a `FlowViewModel` / `ServiceViewModel` — not about rendering nodes and edges.
If TypeScript here starts growing opinions about how a flow is drawn, that work
belongs upstream.

> Historical note: this document previously said `packages/eventflow-ui` would
> become the single source both IDEs consume. That was written before we read
> `zenwave-architectural-vistas`, where the extraction had already happened.
> Vendoring here would have made a third copy of the same React code.

## Relationship to the IntelliJ plugin

Both IDE clients sit downstream of the same three upstreams, and embed the same
EventFlow bundle. Where the two differ in behaviour, it should be because the
host forced it — not by accident.
