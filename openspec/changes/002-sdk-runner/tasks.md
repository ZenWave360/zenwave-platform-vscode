# 002 — Tasks

## 1. Prerequisites

- [x] 1.1 Consume `@zenwave360/dsl` from a local build for now: declare the
      dependency by version and link the package Kotlin/JS produces at
      `dsl-kotlin/build/js/packages/dsl-kotlin`, so nothing has to change when it
      is published
- [x] 1.2 Record that installing from a clean checkout fails until it is
      published — it is not on the registry today, and `008`'s pipeline will go
      red the moment this change lands
- [x] 1.3 **Upstream (`dsl-kotlin`):** record plugin config options in
      `locations`, as the top-level `config` block already does. Without them a
      client cannot recover what was literally written and must re-quote from the
      semantic value, while IntelliJ reads the raw source text — so the two IDEs
      emit different command lines for the same declaration. This is the
      cross-IDE divergence `design.md` warned about, now real
      Verified through `parseModel` by `parseModel exposes locally built DSL plugin
      config option and value spans`; the linked build has spans, not yet published.
- [ ] 1.4 The catalogue reports a documentation location for plugins — available
      to me. Prerequisite: `../zenwave-specs/openspec/changes/001-ide-client-contracts/tasks.md`
      task 3.2; the shipped catalogue currently reports no plugin documentation links.

## 2. Model access

- [x] 2.1 Add `@zenwave360/dsl` as a runtime dependency of `packages/extension`
      and confirm it bundles for `platform: browser` as well as `node`
- [x] 2.2 A `parseModel(text)` wrapper that returns the parsed model plus its
      `locations` map, and returns nothing rather than throwing on a document
      that does not parse
- [x] 2.3 Convert a `locations` tuple to a VS Code `Range`, minding that ANTLR
      lines are 1-based and columns 0-based — cover it with a test
- [x] 2.4 Cache the parse per document URI + version, so a CodeLens refresh on
      an unchanged document does not re-parse

## 3. Plugin discovery

- [x] 3.1 Read plugin declarations out of the parsed model: name, disabled flag,
      config options, CLI options
- [x] 3.2 Interpret the inherit clause correctly — `parseZdl` reports it as the
      string `"inherit false"`, not a boolean, so truthiness always inherits
- [x] 3.3 Fixtures for all three forms: no clause, `(inherit true)`,
      `(inherit false)`
- [x] 3.4 Read the enclosing `config` block options, and the model's imports
- [x] 3.5 Skip plugins declared `disabled`
- [x] 3.6 Fixtures: a model with three plugins, one of them disabled; a model
      with no `config` block; a model with an unbalanced brace
- [x] 3.7 Every declaration of the same plugin type is runnable, each with its
      own options and Run action
- [x] 3.8 Read configuration-level CLI options from the parser's top-level
      `cliOptions` output without inspecting or reparsing source text

## 4. Command assembly

- [x] 4.1 Pass the plugin as the SDK's `-p` option, not positionally
- [x] 4.2 Merge inherited `config` options with plugin options, plugin wins
- [x] 4.3 Honour `(inherit false)` after the plugin name
- [x] 4.4 Default `zdlFile` to the containing file unless `zdlFile` or
      `zdlFiles` is already declared
- [x] 4.5 Collect Maven-coordinate imports into a single `--deps` argument,
      leaving relative file imports out of it
- [x] 4.6 Substitute `${this.file.path}` in option values
- [x] 4.7 Append CLI options verbatim, in declaration order
- [x] 4.8 Prefix with `zenwave.sdk.cliCommand`, append `zenwave.sdk.extraArgs`
- [x] 4.9 Quote injected paths that contain spaces; re-quote parser-normalized
      values containing whitespace — test with a Windows path containing a space
- [x] 4.10 Unit-test assembly against the IntelliJ behaviour, one test per rule in
      the delta spec
- [x] 4.11 Inherit configuration-level CLI options unless the plugin declares
      `(inherit false)`; let a plugin-local option replace a same-named inherited
      option without duplication, preserving deterministic declaration order
- [x] 4.12 Cover shared valueless flags, valued options, local overrides,
      inheritance opt-out and multiple plugin declarations in unit tests

## 5. CodeLens

- [x] 5.1 A CodeLens provider for `zdl`, one lens per enabled plugin declaration
- [x] 5.2 Lens title reads as a Run action; tooltip carries the full command line
- [x] 5.3 Register only when `canRunProcesses`; refresh lenses when
      `zenwave.sdk.*` settings change

## 6. Running

- [x] 6.1 Contribute a `zenwave-sdk` task type whose definition is only the
      plugin name and its model file — nothing that changes when the declaration
      is edited — so a plugin is a task a user can bind or write in `tasks.json`
- [x] 6.2 A task provider building a `ShellExecution` with the model file's
      directory as `cwd`
- [x] 6.3 The `zenwave.sdk.run` command: re-check `canRunProcesses`, check
      workspace trust, then execute the task
- [x] 6.4 ~~Check workspace trust before the catalogue too~~ — superseded: no
      catalogue process is started (see 11.3)
- [x] 6.5 Surface a non-zero exit as a failed run
- [x] 6.6 `TaskPanelKind.Dedicated`, with the assembled command in the task
      definition, so the same command reuses a terminal and a different command
      opens another
- [ ] 6.7 Confirm a run never lands in a terminal the user opened themselves
- [x] 6.8 Different commands, including two declarations of the same plugin
      type, run concurrently in their own task terminals
- [x] 6.9 A setting choosing between the inherited environment and a login shell,
      honoured by the runner **and** the catalogue
- [x] 6.10 Diagnose a command that cannot be found, without starting the SDK:
      look the executable up on the inherited PATH before the run; through a
      login shell, report exit status 127 after it
- [x] 6.11 Fixture: a Windows path with a space run through a bash shell — the
      backslash-as-escape case
- [x] 6.12 Let an explicit login shell override VS Code's preferred terminal
      shell; otherwise use the preferred shell with family-appropriate command
      arguments
- [x] 6.13 Give `ShellExecution` the assembled command as one shell-ready string,
      so the Tasks terminal echoes a command the user can copy and run by hand

## 7. Plugin catalogue and completion

- [x] 7.1 ~~Invoke the configured SDK for its catalogue~~ — superseded: the
      installed SDK is not asked (see 11.3)
- [x] 7.2 Parse the result: plugins by `configClassName`, each with its `options`
      map of `defaultValue`, `description`, `type`, `values`
- [x] 7.3 Present a plugin as its class name without the SDK package prefix, as
      IntelliJ does, so declarations match between the two IDEs
- [x] 7.4 ~~Cache per session; re-read when `zenwave.sdk.cliCommand` changes~~
      — superseded (see 11.3)
- [x] 7.5 Ship the catalogue of a standard release as an asset, and use it when
      the installed SDK cannot be asked
- [x] 7.6 ~~Never merge the two~~ — superseded: there is only the shipped
      catalogue (see 11.3)
- [x] 7.7 Mark suggestions and explanations that come from the shipped catalogue,
      so a user can tell them from their own SDK's
- [x] 7.8 Regenerate the shipped catalogue at release time, and record which SDK
      release it came from
- [x] 7.9 ~~`zenwave.sdk.refreshPlugins` command~~ — removed with the installed
      catalogue (see 11.3)
- [x] 7.10 A completion provider for `zdl`: plugin names where a plugin may be
      declared, options inside a declared plugin
- [x] 7.11 Option items carry description, type, default and allowed values
- [x] 7.12 ~~Resolve the catalogue asynchronously~~ — superseded: the shipped
      catalogue is available synchronously (see 11.3)
- [x] 7.13 ~~A missing or failing CLI falls back to the shipped catalogue~~ —
      superseded (see 11.3)
- [x] 7.14 A hover provider for `zdl`: plugin names and plugin options, from the
      same catalogue
- [x] 7.15 Hover content: what the SDK reports, plus a documentation link when reported
- [x] 7.16 Take the documentation location from the catalogue; never construct
      one from a plugin's name — a workspace's own plugins have no such convention
- [x] 7.17 Offer no link when the catalogue reports none
- [x] 7.18 ~~Gate installed-catalogue process execution~~ — superseded: authoring
      starts no process on any host (see 11.3)

## 8. Contributions and settings

- [x] 8.1 `zenwave.sdk.cliCommand` (default `jbang zw`) and
      `zenwave.sdk.extraArgs`, both `resource`-scoped so a workspace can override
- [x] 8.2 `zenwave.sdk.run` in `commands`, hidden from the palette — it takes
      arguments and is meaningless without a lens
- [x] 8.3 Activation on `onLanguage:zdl` already covers this; confirm no new
      activation event is needed

## 9. Verification

Automated portions of 6.8, 9.3, 9.6, 9.9, 9.10, 9.12 and 11.6 pass locally in
`test/smoke.ts`: enabled-only desktop lenses, no browser lenses, shipped plugin
and option completion/hover, option-edit opens a new terminal with a fixture CLI,
unsupported-shell refusal, and missing-executable refusal with PATH diagnostics.
These tasks stay open for the human's real-SDK and UI checks.

- [x] 9.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [x] 9.2 Browser bundle still free of Node APIs after adding `@zenwave360/dsl`
- [ ] 9.3 Desktop: lenses appear on the fixture, a run generates into the right
      directory, and running the same command twice reuses one terminal
- [ ] 9.4 Desktop: a failing plugin reports failure
- [ ] 9.5 Restricted Mode: the run refuses and explains
- [ ] 9.6 Desktop: plugin-name and option completion and hover come from the
      shipped catalogue, marked with its SDK version, and start no process
- [ ] 9.7 Hover a plugin and an option: what the SDK reports, and a link that
      resolves
- [ ] 9.8 A workspace declaring a plugin of its own: explained on the same terms,
      with no invented link
- [ ] 9.9 `npm run run-in-browser`: a plugins block can be written and understood
      from the shipped catalogue, marked as such, and nothing offers to run it
- [ ] 9.10 An unreachable SDK command: Run reports what was looked for and
      where, before any terminal opens; completion is unaffected
- [ ] 9.11 With the login-shell option on, a tool installed only by a shell
      version manager is found by the runner, and a missing one is reported after
      the run
- [ ] 9.12 `npm run run-in-browser`: no lenses, shipped-catalogue completion
      available, no errors in the console, highlighting unaffected
- [x] 9.13 `openspec validate 002-sdk-runner --strict`

## 11. Review follow-ups (2026-09-16)

- [x] 11.1 Put the assembled command in the task definition, so a later Run
      reuses a terminal only when the command is unchanged
- [x] 11.2 Quote every model and settings value for the task's shell — POSIX or
      PowerShell — including CLI options; refuse `cmd.exe` and other shells, and
      PowerShell arguments containing a double quote, with an explanation
- [x] 11.3 Stop invoking `-h json`: no Run preflight and no installed catalogue;
      completion and hover use only the catalogue generated in CI
- [x] 11.4 Pass numeric option values as their digits (the parser reports Kotlin
      `Long` objects)
- [ ] 11.5 **Upstream (`dsl-kotlin`):** numbers are JS numbers in `parseZdl`
      output, and a negative number keeps its sign — filed in `zenwave-specs`
      `001-ide-client-contracts` task 4.6
- [ ] 11.6 Desktop: run a plugin, edit an option, run it again — a second
      terminal; run the same command again — that second terminal; with tasks
      defaulting to `cmd`, Run refuses and explains
- [ ] 11.7 Decide whether and when an installed SDK is asked for its catalogue
      (design: "The installed SDK is not asked, for now")

## 10. Archive

- [ ] 10.1 `openspec archive 002-sdk-runner`
