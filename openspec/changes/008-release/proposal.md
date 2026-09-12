# 008 — Release

## Why

Everything specified so far describes an extension nobody can install.

There is no `.github/`, no workflow, and nothing anywhere that says how a commit
becomes something a user has. `openspec/project.md` settles the marketplace
identity — `ZenWave360.zenwave-platform` — and `001-extension-foundation` set up
`.vscodeignore` and a `package` script, and that is the whole of it. The VSIX has
never been built by anything but a person, on their machine, by hand.

Two things make this worth specifying rather than improvising:

**Open VSX is not optional here.** The audience for a modelling extension
includes people on VSCodium, Cursor, Windsurf, Gitpod and Eclipse Theia, none of
which can reach the Microsoft marketplace. Publishing to one registry and not the
other is a decision, and the default — forgetting — is the wrong one.

**A release is the one thing that cannot be fixed forward.** A bad version
number, a VSIX missing its grammars, a publish from a dirty tree: each is
permanent in a way a bug is not. Marketplace versions cannot be replaced or
deleted, only superseded.

## What Changes

- **A published extension**, on both the VS Code Marketplace and Open VSX, from
  one build.
- **Releases come from CI**, from a tagged commit, not from a developer's
  machine.
- **A version is traceable** to the commit it was built from, and the same commit
  produces the same artifact.
- **A pre-release channel**, so the web host and the language server can be
  exercised by willing users before they are promised to everyone.
- **What ships is checked before it ships** — the package contains what it should
  and nothing else, and it activates in both hosts.

## Capabilities

### New Capabilities

- `release`: how a commit becomes an installable extension — what the package
  contains, how it is versioned, where it is published, and what is verified
  before it is.

## Impact

- **`.github/workflows`** — the repository's first CI, which is also where the
  verification steps in `AGENTS.md` stop being a checklist somebody remembers.
- **Marketplace credentials** for two registries, held as repository secrets.
  Someone has to own the accounts; this is the change that forces the question.
- **`packages/extension/package.json`** — release metadata the marketplace listing
  is built from, which today is minimal.
- **`CHANGELOG.md`** — currently one `[Unreleased]` section, which becomes the
  source of what a release says it contains.
- **Independent of everything else.** It needs no upstream work and no language
  server. It could ship with only `002-sdk-runner` implemented, and arguably
  should, because a released alpha that runs plugins is worth more than an
  unreleased one that does everything.

## Non-goals

- **Deprecating or coexisting with `zdl-vscode`.** The published predecessor
  contributes the same language ids, and what happens to a user with both
  installed is a real question — deliberately deferred, not overlooked.
- **Telemetry.** Not collected, and not made collectable here.
- **Signing and verified publisher status.** Worth having; not required to ship.
