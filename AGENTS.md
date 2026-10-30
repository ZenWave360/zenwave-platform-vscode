# Working in this repository

Applies to humans and coding agents alike.

## Read first

1. [`zenwave-specs/AGENTS.md`](https://github.com/ZenWave360/zenwave-specs/blob/main/AGENTS.md) — how specs and code relate, and the workflow
2. [`zenwave-specs/zenwave-platform-vscode/architecture.md`](https://github.com/ZenWave360/zenwave-specs/blob/main/zenwave-platform-vscode/architecture.md) — how this client is built
3. [`zenwave-specs/architecture/stack.md`](https://github.com/ZenWave360/zenwave-specs/blob/main/architecture/stack.md) — how the pieces fit, and [`status`](https://github.com/ZenWave360/zenwave-specs/blob/main/architecture/status.md) for what is built

In the workspace these are at `../zenwave-specs/`. [`docs/README.md`](docs/README.md)
lists every document for this project. Cross-repository flows (EventFlow, the LSP
requests, the webview protocol) are under `flows/` there.

## The workflow, briefly

Behaviour is **described in `zenwave-specs` first**, then implemented here. Edit the
document, mark the rule *proposed*, implement, and flip it to *exists* when the code
makes it true. Cite the rule in the commit as `spec:<document>#<id>`.

## Rules that are easy to get wrong

**Cross-repo contracts do not belong in this repo's code comments or docs.**
Behaviour local to this VS Code client goes in `zenwave-specs/zenwave-platform-vscode/`.
Anything that binds repos together (LSP surface, view-model shapes, manifest
semantics, SDK CLI contract, what the DSL parser returns) goes in
`zenwave-specs/flows/`. The test: would breaking it break another repo?

**When the blocker is upstream, file it — do not just report it.** This client sits
downstream of moving repositories, and most of what blocks it is in one of them.
Record the need in the spec as a rule or numbered question, add the work to the
[backlog](https://github.com/ZenWave360/zenwave-specs/blob/main/work/backlog.md) under the repository that owns it (with the file, the line and what breaks), and
phrase the local prerequisite as *"this is available to me"*, ticked when it is. The
full procedure is in `zenwave-specs/AGENTS.md`.

**Small additive upstream fixes may be made directly.** Mirroring a pattern that
already exists in that repository, with a test, and changing nothing an existing
consumer sees — that is cheaper to do than to file. Anything that changes a shape
another consumer reads is not: an agent that knows only this client will design for
this client, and the other IDE finds out when it breaks.

**Never import a Node API from shared code.** Only `src/node/` may. The browser
bundle is built with `platform: browser` and a transitively-reached `node:fs` fails
at runtime inside a Web Worker, not at build time. Keeping the Node surface in one
file is what makes this structural rather than a matter of discipline.

**Gate features on host capabilities, do not let them fail.** `zenwave-sdk` is
JVM-only via JBang and can never run in a browser. Hide what cannot work, and log
why to the output channel.

**Do not reimplement model semantics.** Parsing and semantics come from the Kotlin
Multiplatform packages (`@zenwave360/dsl`, and later `@zenwave360/lsp-js`). If
TypeScript is about to grow an opinion about what a model means, that is a signal to
push the work upstream.

## Conventions

- TypeScript, `strict`; no `any` at module boundaries
- Commands: `zenwave.<area>.<verb>` — settings: `zenwave.<area>.<setting>`
- Context keys: `zenwave.<capability>Available` for `when` clauses

## Verify before claiming done

```bash
node ../zenwave-specs/tools/check-refs.mjs .
npm run typecheck
npm run build
npm run run-in-browser
```

Test **both** hosts. A change that works on the desktop can still be broken in the
browser, and the browser failure will not show up in a build.
