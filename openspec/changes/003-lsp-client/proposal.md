# 003 — Language server client

## Why

Everything still on the roadmap needs the same thing first: a connection to the
ZenWave language server.

- The **EventFlow panel** (`004`) needs a positioned flow/service view model. In
  IntelliJ that JSON is produced in Kotlin and handed straight to the viewer;
  VS Code has no Kotlin, so it has to ask the server.
- The **side-by-side preview** (`005`) needs rendered representations. Same story,
  and settled explicitly: preview content is produced inside the LSP so that
  IntelliJ and VS Code show the same thing.
- Diagnostics, completion, hover, go-to-definition and formatting — everything
  IntelliJ gets from `ZenwaveLspProjectService` today — arrive with the same
  connection, for free.

Specifying the client separately, rather than folding it into `004`, is what
stops two panels from each inventing their own idea of "is the server there?".
It is also the change that has to be honest about a hard fact: this is the only
capability on the roadmap whose implementation is **blocked upstream**.
`zenwave-lsp/lsp-js` is an empty stub, and the JVM server has no launcher yet.
The spec can be written and reviewed now; the code waits.

## What Changes

- A language client for `zdl` and `zfl` documents, started at activation when the
  current host has a usable transport.
- **One server, two transports**: `@zenwave360/lsp-js` shipped with the
  extension, run as a Node child process on the desktop and in a Web Worker in
  the browser. Where neither transport is usable, the extension carries on with
  grammars only.
- **One architecture manifest per workspace**, resolved from a setting or from a
  `.zenwave/config.yml` at a workspace folder root, and passed to the server as
  initialization options — the shape `ZenwaveLspProjectService` already expects.
- **A typed way for feature code to issue `zenwave/*` requests** and to be told
  the server is unavailable rather than hanging.
- **Diagnosability**: server state in the output channel, a context key for `when`
  clauses, an explicit restart command, and LSP tracing behind a setting.

## Capabilities

### New Capabilities

- `lsp-client`: establishing and supervising the connection to the ZenWave
  language server, choosing a transport for the current host, and exposing both
  standard and ZenWave-specific language services to the rest of the extension.

### Modified Capabilities

- `host-capabilities`: the `languageServer` capability is reported as `none`
  today because change 001 deliberately shipped no client. This change makes it
  report the transport that is actually usable, and adds the corresponding
  context key to the activation log.

## Impact

- **Blocked on upstream**, but by less than an earlier draft of this proposal
  assumed. `zenwave-lsp` needs `lsp-js` to have actual sources — it is currently
  a `.gitkeep`. No JVM launcher is required: the server is the same JavaScript in
  both hosts.
  - The desktop path needs nothing further; Node is present, so even the
    Node-only filesystem loader in the dependency chain works there.
  - The **browser** path additionally needs the KMP browser work in
    `zenwave-specs/002`. Until that lands the web host falls back to grammars
    only, and the spec requires that to be a clean, explained fallback rather
    than a failure.
- **No Java for the editor.** Java and JBang remain a requirement of
  `zenwave-sdk` code generation, and stop being one for language features.
- **New dependency** on `vscode-languageclient` in `packages/extension`, with the
  node and browser entry points importing different sub-paths — a new instance of
  the host boundary `AGENTS.md` protects.
- **New cross-repo contract surface.** The `zenwave/*` requests this client
  issues are exactly what `zenwave-specs` exists for; the contract deltas are
  proposed there alongside this change.
- **Unblocks `004` and `005`**, neither of which can be implemented before it.
