# 001 — Design

## Two entries, one activation

```
src/node/extension.ts     ──┐
                            ├──> src/activate.ts (host-agnostic)
src/browser/extension.ts  ──┘
```

The entry files exist **only** to construct the host-specific services and hand
them to the shared `activate()`. No feature logic lives in them.

This matters more than it looks. The failure mode in dual-host extensions is a
Node API (`fs`, `child_process`, `path`) reached transitively from shared code —
esbuild happily bundles it for `platform: browser`, and it explodes at runtime in
a context that is hard to debug. Keeping the Node surface in one file that the
browser bundle never imports makes that structurally impossible rather than a
matter of discipline.

`package.json` declares both:

```json
"main":    "./dist/node/extension.js",
"browser": "./dist/browser/extension.js"
```

VS Code picks by host. The browser bundle is CJS (the worker host does not take
ESM), and needs `globalThis` shims for anything expecting Node globals — we avoid
needing them by not depending on such code.

## Capability model

```ts
interface HostCapabilities {
  readonly canRunProcesses: boolean;  // spawn a CLI (JBang, zenwave-sdk)
  readonly canUseTerminal: boolean;   // ShellExecution tasks
  readonly hasLocalFileSystem: boolean;
  readonly languageServer: 'jvm' | 'worker' | 'none';
}
```

Determined by construction, not by sniffing: the Node entry knows it is Node.
That is more honest than inspecting `vscode.env` from shared code, and it means
the browser bundle contains no dead branch claiming process support.

`languageServer` is reported as `'none'` for now in both hosts — change 001 does
not connect to a server. The field exists so that `lsp-client` (a later change)
extends a value rather than introducing the concept.

Capabilities reach `package.json` through context keys:

| Context key | Meaning |
| --- | --- |
| `zenwave.canRunSdk` | SDK runner UI may be shown |
| `zenwave.canUseTerminal` | terminal-backed actions may be shown |

`when` clauses use these so unavailable commands are **absent**, not present and
failing. Commands are also guarded in code — a context key is a UI hint, and the
command palette is not the only way to invoke a command.

## Why gate rather than degrade

An alternative is to always show the SDK runner and surface an error when it
cannot run. Rejected: in the browser the answer is permanently no, not
temporarily no. A button that can never work is a bug report generator.

Where a feature is *partially* available, degrade instead — that is a per-feature
call for later changes.

## Build

esbuild, one config, two invocations. Chosen over webpack (what `zdl-vscode`
used) for build speed and because `platform: node` / `platform: browser` is a
one-line difference rather than two config files.

Watch mode rebuilds both so the desktop and web dev loops stay in step.

## Language contributions

The grammars started as a copy of `zdl-vscode`'s, on the reasoning that a rewrite
would swamp the structural work that is the point of change 001. That held until
the grammars were actually exercised, at which point the copy turned out to be
broken rather than merely basic:

- `\b(disabled)\b?` in `pluginsBlock` applies `?` to a zero-width assertion.
  Oniguruma rejects it outright — *"target of repeat operator is invalid"* — so
  **ZDL tokenization died at the first `plugins {` block** and everything after
  it in the file was mis-highlighted.
- Comments were delegated to `source.java#comments`, a grammar this extension
  does not contribute. In ZFL that left `/** … */` unconsumed, so an apostrophe
  inside prose (`the processor's response`) opened a single-quoted string that
  **swallowed the remainder of the file**.
- Plugin declarations were a plain `match` rule inside a `plugins { … }`
  `begin`/`end` block, so nothing consumed their nested braces. The **first**
  plugin's closing brace terminated the whole `plugins` block, and every plugin
  after it fell out of the block unscoped. Each plugin is now its own
  `begin`/`end` block, which balances the braces.

Plugin names carry `entity.name.type.zdl` — the same scope as entities — and
`config` / plugin option keys carry `variable.other.member.zdl`, the same scope
as entity fields. ZDL uses `key value` without a colon, so the pre-existing
`#pairs` rule (which requires one) never fired on them.

So the grammars were merged with the newer lineage used by the ZenWave website
and blog, which already defined comments natively. The IDE lineage stays the
base — its `begin`/`end` block rules give contextual `meta.block.*` scoping that
the flat web version lacks — with these carried over: native comments (including
a distinct documentation-comment scope), `import` / `@import(...)`, lowercase
primitive type names, event lists (`[A|B]`), ZFL outcome labels, `emits` as a
keyword, and `service System.Service` references.

Verified by tokenising the fixtures with `vscode-textmate`: every regex compiles,
no external scope is referenced, and ZFL unscoped tokens fell from "the whole
file is one string" to 19%.

The website and blog copies were deliberately left alone. Four copies of this
grammar exist across the workspace; consolidating them is a real problem but not
this change's problem.

## Open questions deferred

- Whether `preview-renderer` becomes a real package or stays a directory until
  its change lands. Left as a placeholder here.
  *(An `eventflow-ui` placeholder was also created and has since been removed:
  EventFlow is owned upstream by `zenwave-architectural-vistas`, so there is no
  local package to decide about. See `docs/architecture.md`.)*
- Whether the browser host can reach a remote JVM language server over
  WebSocket. Belongs to `lsp-client`.
