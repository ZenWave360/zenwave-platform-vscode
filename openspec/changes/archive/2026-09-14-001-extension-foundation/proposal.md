# 001 — Extension foundation

**Status:** proposed

## Why

There is nothing here yet. Before any of the interesting capabilities (LSP
client, preview, SDK runner, EventFlow panel) can be specified, the project
needs a skeleton that establishes the two structural facts everything else
depends on:

1. **The extension runs in two hosts** — the Node extension host (desktop) and
   the Web Worker extension host (vscode.dev, github.dev, Codespaces in browser).
2. **Those hosts are not equally capable**, and `zenwave-sdk` being JVM/JBang-only
   means at least one headline feature can never work in the browser.

Getting capability gating right *first* is deliberate. If it is retrofitted, the
failure mode is a UI full of buttons that do nothing in web mode, which is worse
than not offering them — the user cannot tell a missing feature from a broken one.

Syntax highlighting is included because it is the one capability that is fully
self-contained: it needs no server, no process and no network, so it works
identically in both hosts and gives the skeleton something real to prove itself
against.

## What changes

- A dual-entry VS Code extension that activates in both hosts.
- A host-capability probe, exposed to `package.json` `when` clauses via context
  keys and to code via an injected service.
- ZDL and ZFL language contributions: file associations, TextMate grammars,
  editor configuration (comments, brackets, auto-closing, folding).
- Grammars and the language configuration carried over from `zdl-vscode`.

## Scope

**In scope**

- `packages/extension` with `node` and `browser` entry points over one shared
  `activate()`.
- `host-capabilities` and `languages` capabilities.
- esbuild build producing both bundles; `@vscode/test-web` able to launch it.
- Marketplace identity as `ZenWave360.zenwave-platform`.

**Non-goals** — each gets its own change:

- Any language-server connection. No `lsp-client` code lands here.
- Preview rendering, Mermaid, or the Handlebars port.
- CodeLens or any `zenwave-sdk` invocation.
- The EventFlow panel, or wiring up the upstream `@zenwave360/vistas-eventflow`
  webview bundle.
- Deprecating the published `zdl-vscode` extension.

## Risks

- **Grammar drift.** The carried-over grammars are a snapshot of `zdl-vscode`.
  Once the LSP provides semantic tokens, TextMate becomes the fallback layer,
  not the primary one. Accepted: highlighting must work with zero infrastructure.
- **Capability probing is guesswork at the edges.** `vscode.env.uiKind` and
  `extensionKind` do not cleanly answer "can I spawn a JVM". We probe for what we
  can observe and treat the rest as unavailable rather than assuming success.
