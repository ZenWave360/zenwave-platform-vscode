# ZenWave Platform for VS Code

VS Code client for the ZenWave Platform's modelling languages — **ZDL** (domain
modelling and API design within a bounded context) and **ZFL** (event-storming
flow modelling across bounded contexts).

> **Early access, work in progress.**
> This supersedes [`zdl-vscode`](https://github.com/ZenWave360/zdl-vscode) and is
> the sibling of the IntelliJ plugin
> [`ZenWaveDomainModelEditor`](https://github.com/ZenWave360/ZenWaveDomainModelEditor).

## Planned capabilities

| | Desktop | Web (vscode.dev) |
| --- | :---: | :---: |
| ZDL / ZFL syntax highlighting | ✅ | ✅ |
| Language server — diagnostics, completion, navigation | planned | planned |
| Markdown preview with Mermaid diagrams | planned | planned |
| EventFlow diagram panel | planned | planned |
| Run ZenWave SDK code generation | planned | ❌ never |

The last row is not an omission. `zenwave-sdk` is JVM-only and launched through
JBang, so it cannot run in a browser. Rather than showing a button that fails,
the extension detects what the host can do and hides what it cannot — see
[`openspec/project.md`](openspec/project.md).

## Repository layout

```
packages/extension/        the VS Code extension
packages/preview-renderer/ ZDL/ZFL → Markdown + Mermaid   (placeholder)
openspec/                  specs and change proposals — read this first
docs/                      architecture and decision records
```

The EventFlow diagram is **not** built here. It lives upstream in
`zenwave-architectural-vistas` as `@zenwave360/vistas-eventflow`, which already
publishes a webview bundle that the IntelliJ plugin consumes. This extension
consumes the same package rather than keeping its own copy.

## Development

Requires Node 20+.

```bash
npm install
npm run build          # both bundles
npm run watch          # rebuild on change
npm run typecheck
npm run run-in-browser # launch in a browser host via @vscode/test-web
```

In VS Code, **Run Extension (Desktop)** and **Run Extension (Web)** launch
configurations open the `packages/extension/fixtures` folder. Test both: a change
that works on the desktop can still be broken in the browser.

## How work happens here

This project uses spec-driven development. **Read
[`openspec/README.md`](openspec/README.md) before writing code** — behaviour is
proposed and reviewed as a spec delta first.

We use the [OpenSpec](https://github.com/Fission-AI/OpenSpec) CLI:

```bash
npm i -g @fission-ai/openspec   # mind the scope: plain `openspec` is an empty placeholder
openspec list                   # in-flight changes
openspec doctor                 # healthy root? do references resolve?
```

One deviation from upstream: **the spec is not the single source of truth.**
Spec and code are jointly authoritative — the spec owns observable behaviour and
contracts, the code owns implementation. When they disagree, that is a decision
to make, not an automatic rewrite.

This repo is its own OpenSpec root and reads the shared `zenwave-specs` store as
a read-only reference. Behaviour local to this client stays here; contracts that
bind repos together go to the store.

Current work: [`openspec/changes/`](openspec/changes/).

## Upstream

Model semantics and language services live in other repositories, both work in
progress. This repo presents and drives them; it does not reimplement them.

- **zenwave-manifest** — `manifest-core`, `manifest-graph`, `workspace-runtime`,
  MCP adapter, all architectural semantics
- **zenwave-lsp** — LSP mapping, document/language services, JVM + JS transports,
  IntelliJ and VS Code clients

## License

MIT
