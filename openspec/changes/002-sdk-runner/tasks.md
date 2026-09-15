# 002 — Tasks

## 1. Prerequisites

- [x] 1.1 Consume `@zenwave360/dsl` from a local build for now: declare the
      dependency by version and link the package Kotlin/JS produces at
      `dsl-kotlin/build/js/packages/dsl-kotlin`, so nothing has to change when it
      is published
- [x] 1.2 Record that installing from a clean checkout fails until it is
      published — it is not on the registry today, and `008`'s pipeline will go
      red the moment this change lands

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

## 5. CodeLens

- [x] 5.1 A CodeLens provider for `zdl`, one lens per enabled plugin declaration
- [x] 5.2 Lens title reads as a Run action; tooltip carries the full command line
- [x] 5.3 Register only when `canRunProcesses`; refresh lenses when
      `zenwave.sdk.*` settings change

## 6. Running

- [x] 6.1 Contribute a `zenwave-sdk` task type, whose definition includes the
      plugin name and the working directory — so a plugin is a task a user can
      bind or write in `tasks.json`
- [x] 6.2 A task provider building a `ShellExecution` with the model file's
      directory as `cwd`
- [x] 6.3 The `zenwave.sdk.run` command: re-check `canRunProcesses`, check
      workspace trust, then execute the task
- [x] 6.4 Check workspace trust before the catalogue too — it spawns a process
      rather than a task, so the platform does not block it
- [x] 6.5 Surface a non-zero exit as a failed run
- [x] 6.6 `TaskPanelKind.Dedicated`, so repeated runs of one plugin reuse their
      terminal instead of opening another
- [ ] 6.7 Confirm a run never lands in a terminal the user opened themselves
- [ ] 6.8 Check what running a plugin does while its previous run is still going
- [x] 6.9 A setting choosing between the inherited environment and a login shell,
      honoured by the runner **and** the catalogue
- [x] 6.10 Diagnose a command that cannot be found: what was run, and where it was
      looked for
- [x] 6.11 Fixture: a Windows path with a space run through a bash shell — the
      backslash-as-escape case

## 7. Plugin catalogue and completion

- [x] 7.1 Invoke the configured SDK for its catalogue — IntelliJ appends `-h json`
      to the configured command — capturing stdout rather than using a terminal
- [x] 7.2 Parse the result: plugins by `configClassName`, each with its `options`
      map of `defaultValue`, `description`, `type`, `values`
- [x] 7.3 Present a plugin as its class name without the SDK package prefix, as
      IntelliJ does, so declarations match between the two IDEs
- [x] 7.4 Cache per session; re-read when `zenwave.sdk.cliCommand` changes
- [x] 7.5 Ship the catalogue of a standard release as an asset, and use it when
      the installed SDK cannot be asked
- [x] 7.6 Never merge the two; an installed SDK's answer replaces the shipped one
- [x] 7.7 Mark suggestions and explanations that come from the shipped catalogue,
      so a user can tell them from their own SDK's
- [x] 7.8 Regenerate the shipped catalogue at release time, and record which SDK
      release it came from
- [x] 7.9 `zenwave.sdk.refreshPlugins` command
- [x] 7.10 A completion provider for `zdl`: plugin names where a plugin may be
      declared, options inside a declared plugin
- [x] 7.11 Option items carry description, type, default and allowed values
- [x] 7.12 Resolve the catalogue asynchronously — never block a completion request
      on the CLI, and answer with nothing until it is ready
- [x] 7.13 A missing or failing CLI falls back to the shipped catalogue, logged
      once rather than per keystroke
- [x] 7.14 A hover provider for `zdl`: plugin names and plugin options, from the
      same catalogue
- [x] 7.15 Hover content: what the SDK reports, plus a documentation link when reported
- [x] 7.16 Take the documentation location from the catalogue; never construct
      one from a plugin's name — a workspace's own plugins have no such convention
- [x] 7.17 Offer no link when the catalogue reports none
- [x] 7.18 Gate installed-catalogue process execution on `canRunProcesses` and
      workspace trust, while retaining the shipped authoring fallback

## 8. Contributions and settings

- [x] 8.1 `zenwave.sdk.cliCommand` (default `jbang zw`) and
      `zenwave.sdk.extraArgs`, both `resource`-scoped so a workspace can override
- [x] 8.2 `zenwave.sdk.run` in `commands`, hidden from the palette — it takes
      arguments and is meaningless without a lens
- [x] 8.3 Activation on `onLanguage:zdl` already covers this; confirm no new
      activation event is needed

## 9. Verification

- [x] 9.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [x] 9.2 Browser bundle still free of Node APIs after adding `@zenwave360/dsl`
- [ ] 9.3 Desktop: lenses appear on the fixture, a run generates into the right
      directory, and running the same plugin twice reuses one terminal
- [ ] 9.4 Desktop: a failing plugin reports failure
- [ ] 9.5 Restricted Mode: the run refuses and explains
- [ ] 9.6 Desktop: plugin-name and option completion match what the configured
      SDK reports; a second request does not re-invoke the CLI
- [ ] 9.7 Hover a plugin and an option: what the SDK reports, and a link that
      resolves
- [ ] 9.8 A workspace declaring a plugin of its own: explained on the same terms,
      with no invented link
- [ ] 9.9 `npm run run-in-browser`: a plugins block can be written and understood
      from the shipped catalogue, marked as such, and nothing offers to run it
- [ ] 9.10 An unreachable SDK command: Run reports it, completion is silent, and
      the output channel says why once
- [ ] 9.11 With the login-shell option on, a tool installed only by a shell
      version manager is found by both the runner and the catalogue
- [ ] 9.12 `npm run run-in-browser`: no lenses or process-backed SDK query,
      shipped-catalogue completion remains available, no errors in the console,
      highlighting unaffected
- [x] 9.13 `openspec validate 002-sdk-runner --strict`

## 10. Archive

- [ ] 10.1 `openspec archive 002-sdk-runner`
