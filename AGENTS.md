# Working in this repository

Applies to humans and coding agents alike.

## Read first

1. [`openspec/README.md`](openspec/README.md) — the spec-driven workflow
2. [`openspec/project.md`](openspec/project.md) — project context and settled decisions
3. [`docs/architecture.md`](docs/architecture.md) — how the pieces fit

## The workflow, briefly

Behaviour is **proposed as a spec delta and reviewed before it is implemented**.

```bash
openspec new change <name>          # scaffold changes/<name>/
#   proposal.md   why, what changes, capabilities, impact
#   design.md     technical approach and tradeoffs (skip for trivial changes)
#   tasks.md      implementation checklist
#   specs/<capability>/spec.md      the DELTA against openspec/specs/

openspec validate <name> --strict   # before review
openspec status --change <name>     # while implementing
openspec archive <name>             # folds deltas into specs/, moves to archive/
```

Archiving is the step that keeps the living spec honest. A change is not done
when the code merges. `openspec archive` validates first and does the fold, so
there is no excuse to skip it.

Requires `npm i -g @fission-ai/openspec` — mind the scope; the unscoped
`openspec` package is an empty 0.0.0 placeholder.

## Rules that are easy to get wrong

**Never edit `openspec/specs/` directly.** It is the archived result of deltas.
Propose a change instead, and let `openspec archive` do the fold.

**Check `openspec list --specs` before naming a capability.** Plain
`openspec list` shows in-flight *changes*, not specs — confusing the two is how
a near-duplicate capability gets introduced.

**Cross-repo contracts do not belong here.** This repo is its own OpenSpec root
and references the shared `zenwave-specs` store read-only. Behaviour local to
this VS Code client stays here; anything that binds repos together (LSP surface,
view-model shapes, manifest semantics, SDK CLI contract) goes to the store with
an explicit `--store zenwave-specs`. The test: would breaking it break another
repo?

**Do not put implementation detail in a spec.** The test: could a user or a
neighbouring system notice it? Command ids, activation conditions, rendered
output, settings keys, fallback behaviour — yes. Class structure, bundler choice,
memoisation — no.

**Every requirement needs a `#### Scenario:`.** A requirement without one is a
wish, and usually turns out to be vague once you try to write the scenario.

**Never import a Node API from shared code.** Only `src/node/` may. The browser
bundle is built with `platform: browser` and a transitively-reached `node:fs`
fails at runtime inside a Web Worker, not at build time. Keeping the Node surface
in one file is what makes this structural rather than a matter of discipline.

**Gate features on host capabilities, do not let them fail.** `zenwave-sdk` is
JVM-only via JBang and can never run in a browser. Hide what cannot work, and log
why to the output channel.

**Do not reimplement model semantics.** Parsing and semantics come from the
Kotlin Multiplatform packages (`@zenwave360/dsl`, and later
`@zenwave360/lsp-js`). If TypeScript is about to grow an opinion about what a
model means, that is a signal to push the work upstream.

## Conventions

- TypeScript, `strict`; no `any` at module boundaries
- Commands: `zenwave.<area>.<verb>` — settings: `zenwave.<area>.<setting>`
- Context keys: `zenwave.<capability>Available` for `when` clauses

## Verify before claiming done

```bash
openspec validate --all --strict
npm run typecheck
npm run build
npm run run-in-browser
```

Test **both** hosts. A change that works on the desktop can still be broken in
the browser, and the browser failure will not show up in a build.
