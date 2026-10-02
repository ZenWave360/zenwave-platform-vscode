# 002 — SDK runner

## Why

A ZDL `config { plugins { … } }` block already says exactly what the author wants
generated, and with which options. Everything needed to run `zenwave-sdk` is
sitting in the file the user is looking at — and yet today they have to leave the
editor and retype it:

```
jbang zw -p io.zenwave360.sdk.plugins.JDLToOpenAPIPlugin zdlFile=customer.zdl targetFolder=. …
```

IntelliJ solved this years ago with a gutter Run icon on each plugin
(`ZdlRunPluginLineMarkerContributor`). VS Code has nothing. Closing that gap is
the largest gain per unit of work available right now, and it is the only
headline capability that needs **no upstream work**: `@zenwave360/dsl` already
reports the source location of every plugin declaration, so the editor knows
where to put the lens and what to run without this repo growing any opinion about
what ZDL means.

Doing it before the preview and the EventFlow panel is deliberate: both of those
wait on `zenwave-lsp`, this one does not.

## What Changes

- A **CodeLens** above every enabled plugin declaration in a `.zdl` / `.zw` file.
- A **command** that assembles the `zenwave-sdk` command line from the plugin
  declaration — its own options, the inherited `config` options, `--deps` from
  Maven-coordinate imports, verbatim CLI options, and a defaulted `zdlFile`.
- Execution through a **terminal-backed VS Code task**, with the model file's
  directory as the working directory, and task identity equal to the assembled
  command so the same command reuses a terminal and a different command opens
  another.
- **Settings** for the CLI command (`jbang zw` by default) and for extra
  arguments appended to every run.
- **Honest gating**: no lens at all where processes cannot be spawned, and a
  refusal with an explanation in a restricted (untrusted) workspace.

## Capabilities

### New Capabilities

- `sdk-runner`: recognising runnable plugin declarations in a model file,
  presenting a Run affordance on each, assembling the `zenwave-sdk` command line
  from the declaration, and running it in the workspace.

### Modified Capabilities

None. `host-capabilities` already requires that features which cannot work are
hidden rather than broken; this change is the first real consumer of that
requirement, not a change to it.

## Impact

- **`packages/extension`** — a new feature area, its first CodeLens provider, its
  first task provider, and its first `configuration` settings beyond tracing.
- **New runtime dependency on `@zenwave360/dsl`** for the extension bundle. It is
  a pure-JS ES module and bundles for both hosts; `zdl-vscode` already shipped it
  in the browser.
- **`package.json` contributions** — commands, menus, a `zenwave-sdk` task type,
  and `zenwave.sdk.*` settings.
- **No upstream dependency.** Nothing in `zenwave-lsp`,
  `zenwave-architectural-vistas` or `zenwave-sdk` has to change first.
- **Parity pressure on IntelliJ**: the command-line assembly rules specified here
  are the ones `ZdlRunPluginLineMarkerContributor` already implements. If the two
  drift, that is a bug in one of them, and the assembly rules are a candidate for
  the shared store later.
