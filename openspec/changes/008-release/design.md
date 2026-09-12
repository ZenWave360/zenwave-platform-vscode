# 008 — Design

## Context

What exists: a `package` script (`esbuild --production && vsce package
--no-dependencies`), a `.vscodeignore` that allow-lists `dist`, `syntaxes`,
`resources` and metadata, the identity `ZenWave360.zenwave-platform`, and a
`CHANGELOG.md` with a single `[Unreleased]` section.

What does not exist: any automation at all. There is no `.github/`.

The verification steps this project already relies on are written in
`AGENTS.md` — typecheck, lint, build, `run-in-browser`, and "test **both** hosts,
because a change that works on the desktop can still be broken in the browser".
They are a checklist a person is asked to remember. This change is where they
become something that runs.

## Goals / Non-Goals

**Goals:**

- Both registries, one build, one version.
- Nothing published from a laptop.
- The browser-host check enforced rather than requested.

**Non-Goals:**

- **`zdl-vscode`.** Deferred deliberately; recorded in the proposal so it is a
  decision rather than an oversight.
- **Telemetry.**
- **Automating the version bump or changelog generation.** Deciding what a
  version is called is a judgement; this change requires that the decision is
  recorded, not that it is inferred.
- **Signing, verified publisher, marketplace badges.**

## Decisions

### Open VSX is a requirement, not an afterthought

Publishing only to the Microsoft marketplace excludes VSCodium, Cursor,
Windsurf, Gitpod and Theia — and the overlap between "uses an editor that is not
literally Microsoft's build" and "does domain modelling with a DSL" is not small.

It costs one more publish step and one more credential. The reason to make it a
requirement rather than a task is that the failure mode is silent: nobody files a
bug saying "your extension is absent from a registry I use", they just do not
find it.

The "one registry refuses" scenario exists because the two publishes can diverge,
and a half-published release that nobody notices is worse than a failed one.

### Tags trigger releases; every commit is still built

Separating "build and verify" from "publish" means the expensive checks run
constantly and the irreversible step runs deliberately. A marketplace version
cannot be withdrawn, only superseded — so the asymmetry between the two should be
visible in how they are triggered.

### Pre-release is how the blocked work reaches anyone

Most of this programme depends on upstream that is still moving:
`003`–`007` all wait on `zenwave-lsp`, and the web host waits on the KMP browser
work in `zenwave-specs/002`. When those land they will be worth exercising before
they are promised.

VS Code's pre-release channel is exactly this: users opt in, nobody is moved onto
it, and it is visible which one you are on. Without it, the only options are
shipping unfinished work to everyone or sending people a VSIX by hand.

### Reproducibility is stated as "contains the same extension"

Byte-identical output from a bundler across two runs is a harder promise than
this project needs, and chasing it would mean pinning things that should float.

What matters to a user, and to a maintainer diagnosing a report, is that a
version corresponds to a commit and that rebuilding that commit does not produce
a different extension. That is what the scenario asks for.

### Packaging checks assert what is present, not only what is absent

`.vscodeignore` is an allow-list, which is the safer shape — but an allow-list
fails in the direction of omission. When `004` adds the EventFlow bundle and
`005` adds Mermaid, the failure is a package that builds cleanly, publishes
successfully, and does not work.

So the check is positive: the things the extension needs at runtime are in the
package. That is why "a new asset" is a scenario — it is written for a change
that has not happened yet, which is the point of writing it now.

### The browser check is the one that justifies the automation

Every other failure here is caught by a developer running the extension. The
browser one is not: it builds, it passes typecheck, and it dies inside a Web
Worker on vscode.dev. `001` established the structural defence — the Node surface
confined to `src/node/`, an ESLint rule guarding it — and this adds the last
line, which is actually launching the browser host before publishing.

## Risks / Trade-offs

- **Credentials for two registries** have to be owned by someone and rotated.
  This change forces the question rather than answering it; if no one owns the
  Open VSX account, the requirement cannot be met.
- **A pre-release channel is a promise to keep publishing to it.** An abandoned
  pre-release that is older than stable is worse than none, because users who
  opted in are stuck behind.
- **CI on a monorepo with a single publishable package** is simple now and will
  not stay that way if `packages/preview-renderer` ever publishes. Worth building
  the workflow so that adding a second package is not a rewrite.
- **The browser check is only as good as what it exercises.** Launching the web
  host and opening a fixture catches activation failures; it does not catch a
  feature that fails the first time it is used. It is the cheap line of defence,
  not a substitute for tests.
