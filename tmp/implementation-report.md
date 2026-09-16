# Implementation report: 008-release and 002-sdk-runner

## Commits

- `58be45d` — `008-release: add verified dual-registry pipeline`
- `fcdf436` — `002-sdk-runner: add task-backed SDK authoring and runs`
- `44285e3` — `002-sdk-runner: quote shell arguments safely`
- `c50838a` — `008-release: smoke test the packaged extension`
- `1fa4f3b` — `008-release: inventory runtime assets dynamically`
- `2164c70` — `002-sdk-runner: return shipped catalogue immediately`
- `8d10266` — `002-sdk-runner: preserve CLI option semantics`
- `518df1d` — `002-sdk-runner: scope catalogues to model directories`
- `9723ff0` — `002-sdk-runner: query catalogue only in plugin contexts`
- `07c4157` — `002-sdk-runner: probe the complete SDK command`
- `0901a04` — `002-sdk-runner: inherit the preferred terminal shell`
- `947dde0` — `002-sdk-runner: isolate extension development host`
- `d1d79bd` — `002-sdk-runner: echo a copyable task command`

Both changes remain in `openspec/changes/`. Neither was archived.

## 008-release

Implemented a tag-driven GitHub Actions release pipeline for the desktop and
browser extension bundles, a reproducible VSIX packager, positive and negative
package-content verification, smoke-test harnesses for both VS Code hosts,
build-commit metadata, Marketplace/Open VSX publication from the same artifact,
stable/pre-release tag validation, artifact upload, release documentation, and
release-note/listing metadata. The pipeline publishes only after all checks pass
and has separate publish steps so a partial registry failure is visible.

Automated verification completed:

- strict OpenSpec validation, typecheck, lint, and both bundles
- dry-run release packaging and VSIX content/size/build-metadata verification
- repeat-build byte-for-byte reproducibility check
- deliberate missing-runtime-asset package failure

### Unticked 008 tasks

- **1.1** Marketplace publisher and Open VSX namespace ownership: requires the
  maintainers/organization to identify external account owners.
- **1.2** repository secrets and rotation owners: requires external credentials
  and an organizational decision.
- **2.4** desktop extension-host activation: requires launching and observing a
  VS Code Extension Development Host.
- **2.5** browser extension-host activation: requires launching and observing
  the web extension host.
- **3.4** clean-editor VSIX installation: requires an interactive clean editor.
- **6.2** real prerelease from both registries: requires credentials, publishing,
  and two clean-editor installations.
- **6.3** stable users stay off prerelease: requires a real registry/update-channel
  test.
- **6.4** switching back to stable: requires a real registry/update-channel test.
- **6.5** deliberately broken browser build on a branch: requires a disposable
  remote branch/CI run; no branch was pushed.
- **7.1** archive: explicitly prohibited until human interactive verification.

## 002-sdk-runner

Implemented parser-backed plugin discovery with correct ANTLR range conversion,
inherit handling, command assembly, CodeLens runs, contributed VS Code tasks,
workspace-trust and host-capability gates, dedicated task terminals, inherited
or login-shell process environments, actionable command diagnostics, installed
SDK catalogue discovery and caching, a shipped fallback catalogue, refresh,
completion, hover, fixtures, and unit tests. Node process code is isolated below
`src/node/`; the browser bundle retains parser/catalogue authoring support and
contains no Node API imports.

The SDK invocation uses `-p`; `(inherit false)` is normalized from the parser's
string representation; source locations convert from 1-based line/0-based
column inclusive tuples to VS Code's 0-based/end-exclusive ranges. The exact
runtime dependency is `@zenwave360/dsl@1.9.0-SNAPSHOT`; development uses the
adjacent Kotlin/JS package through `npm link --no-save`, while the lockfile keeps
the normal versioned registry resolution for when it is published.

The release workflow now regenerates and verifies the committed SDK catalogue
from the release SDK before packaging. The catalogue records SDK
`2.8.0-SNAPSHOT` and 19 plugins.

Automated verification completed:

- 33 unit tests passed
- `npm run typecheck`, `npm run lint`, and `npm run build` passed
- desktop and browser bundles passed; the browser Node-import guard passed
- all nine OpenSpec changes/specs validated strictly
- a 19-file VSIX was packaged and verified, including the shipped catalogue

The build emits one upstream warning about malformed mappings in the Kotlin
stdlib source map; it does not fail either bundle.

### Unticked 002 tasks

- **1.3** plugin config option source locations: the adjacent DSL parser does
  not yet expose these ranges; the client still re-quotes semantic values while
  IntelliJ reads source text. The newly recorded upstream prerequisite remains
  unticked.
- **6.7** terminal isolation: requires observing the VS Code terminal UI.
- **6.8** concurrent rerun behavior: requires starting and observing overlapping
  tasks in the editor.
- **9.3** desktop lenses/output/dedicated-terminal reuse: interactive editor test.
- **9.4** failed-plugin presentation: interactive editor test.
- **9.5** Restricted Mode refusal: interactive editor test.
- **9.6** installed-SDK completion and single catalogue query: interactive editor
  plus process observation.
- **9.7** plugin/option hover and resolvable reported link: interactive editor
  test; the current SDK catalogue reports option links but no explicit plugin
  link.
- **9.8** workspace-owned plugin explanation with no invented link: requires a
  workspace plugin on the running SDK classpath and an interactive editor.
- **9.9** browser authoring with marked shipped catalogue and no run affordance:
  interactive browser-host test.
- **9.10** unreachable command behavior: interactive desktop test. The task's
  phrase "completion is silent" conflicts with the delta requirement that a
  failed SDK query falls back to marked shipped knowledge; the implementation
  follows the delta (Run reports the failure, authoring falls back, output logs
  the reason once).
- **9.11** login-shell-only tool discovery by runner and catalogue: needs an
  interactive host and a machine-specific shell setup.
- **9.12** browser absence of lenses/process queries while shipped authoring and
  highlighting remain: interactive browser-host test.
- **10.1** archive: explicitly prohibited until human interactive verification.

## Delta-spec change

Changed
`openspec/changes/002-sdk-runner/specs/sdk-runner/spec.md` in the command
assembly requirement. `parseZdl` removes source quote delimiters from plugin
configuration option values and provides no option-value source range, so the
original requirement to reproduce those values verbatim was impossible without
adding a second ZDL parser (which the design prohibits). The delta now requires
the parser's semantic value and safe re-quoting when it contains whitespace,
with a scenario for `displayName "Orders API"`. CLI option values remain in
source form and retain their quote delimiters. No 008 delta spec was changed.

After interactive testing exposed an empty-login-shell configuration failure,
the same delta's shell-environment requirement was extended: an explicit
`zenwave.sdk.loginShell` wins, otherwise VS Code's preferred terminal shell is
used with family-appropriate command arguments, and an error is reported only
when neither is usable. This was implemented in `0901a04`.

Subsequent F5 attempts aborted the shared extension host with native exit code
134 before ZenWave activated. The development launch profiles now pass
`--disable-extensions`, isolating the extension under development from installed
extensions in the F5 host. An isolated desktop extension-host smoke test on VS
Code 1.137 passed and exited with code 0; the updated F5 profile still requires
human confirmation.

The task execution now passes the assembled shell-ready command to VS Code as a
single string. This restores the delta's copy/paste contract: the Tasks terminal
shows the same readable command as the CodeLens tooltip instead of rendering
every executable and argument as a separately quoted token.

## Human interactive verification checklist

- [ ] Record Marketplace/Open VSX account owners, secret names, and rotation
      owners (008 1.1–1.2).
- [ ] Launch both desktop and browser extension hosts on fixtures and confirm
      activation (008 2.4–2.5).
- [ ] Press F5 with `Run Extension (Desktop)` and confirm the isolated host stays
      alive, ZenWave activates, and the preferred-terminal shell is reported.
- [ ] Run a plugin and confirm the Tasks terminal echoes one readable command
      line that can be copied and rerun in the same shell.
- [ ] Install the generated VSIX in a clean desktop editor (008 3.4).
- [ ] Publish/install a real prerelease from both registries, verify stable does
      not auto-cross channels, then switch back to stable (008 6.2–6.4).
- [ ] On a disposable remote branch, introduce a browser-only Node import and
      confirm CI blocks release (008 6.5).
- [ ] In desktop VS Code, exercise fixture CodeLenses, correct output directory,
      repeated and overlapping runs, failure state, and terminal isolation
      (002 6.7–6.8, 9.3–9.4).
- [ ] In Restricted Mode, confirm Run refuses with an explanation (002 9.5).
- [ ] Verify installed-SDK completion caching, plugin/option hovers and links,
      and a workspace-owned plugin with no invented link (002 9.6–9.8).
- [ ] Point `zenwave.sdk.cliCommand` at a missing command: Run must diagnose the
      command/PATH, output must log once, and completion must use the marked
      shipped fallback (002 9.10, following the delta rather than the stale task
      wording).
- [ ] Configure a version-manager-only SDK and verify login-shell discovery for
      both runs and catalogue queries (002 9.11).
- [ ] Launch the browser host and confirm shipped-catalogue authoring works while
      CodeLenses, tasks, and process queries are absent and highlighting remains
      healthy (002 9.9, 9.12).
- [ ] After all checks pass, archive 008 and 002 separately; archiving was not
      performed here.

## Choices where the specs were silent

- VS Code Marketplace versions must be numeric semver, so stable tags use
  `vX.Y.Z`; prerelease tags use `vX.Y.Z-pre.N`, are packaged as the numeric
  version `X.Y.(Z*2+1+N)`, and are published with each registry's prerelease
  channel flag. Stable patch versions map to even marketplace patch numbers.
- The shipped catalogue is a deterministic, alphabetically normalized snapshot;
  release CI regenerates it explicitly and fails on a diff instead of silently
  changing packaged content.
- A parser-recovered plugin declaration is runnable only when its reported source
  slice closes with `}`. This prevents an unfinished declaration from gaining a
  misleading CodeLens without implementing independent model semantics.
- Completion context is determined by asking `parseZdl` to parse a temporary
  sentinel insertion, avoiding a second grammar implementation.
- Task identity uses plugin plus working directory so `TaskPanelKind.Dedicated`
  can reuse the plugin's terminal; command/environment fields remain optional
  task-definition configuration rather than identity.
- Catalogue documentation links are shown only when explicitly reported. Text
  that merely contains a URL is not promoted to a link.

## Known dependency blocker

`@zenwave360/dsl@1.9.0-SNAPSHOT` is still absent from the npm registry. The local
adjacent Kotlin/JS package was linked for implementation and verification, but a
clean `npm install`/`npm ci` after 002 necessarily remains blocked until that
exact version is published. No stub or path-only dependency was committed.

## Independent specification audit

The fresh verifier read only the two delta-spec directories and
`tmp/verification.diff`. It made no edits. Its original findings were:

1. **Critical — clean CI is blocked.** The release workflow runs `npm ci`, but
   `@zenwave360/dsl@1.9.0-SNAPSHOT` is unpublished and CI has no sibling
   checkout/build/link step. The verifier considers this contrary to 008's
   tagged and ordinary-commit CI scenarios. This is the known dependency blocker
   requested by the implementation order, but it means the combined post-002
   tree's CI cannot currently execute.
2. **High — shell serialization is incomplete.** Plugin values and injected
   paths are quoted only for whitespace and embedded double quotes/shell
   metacharacters are not escaped. Values such as `a;b`, `$(...)`, backticks,
   variables, or globs can change command meaning instead of preserving the
   semantic value.
3. **High — the packaged VSIX is not what smoke tests exercise.** Desktop and
   browser smoke tests run against the development tree before packaging; the
   resulting VSIX is inspected but never installed and activated in either host.
4. **High — omitted future runtime assets are not detected generically.** VSIX
   verification has a fixed allowlist of current required assets, so a newly
   added runtime asset can be omitted without automatically extending the check.
5. **Medium — first completion can be empty.** Catalogue loading returns
   immediately with `undefined`; when the installed SDK is unavailable, the
   shipped fallback becomes visible only after the asynchronous failure, so the
   first completion request (and first request after refresh) returns nothing.
6. **Medium — CLI options are reconstructed, not verbatim.** They are rebuilt as
   `--name`/`--name=value`, are not shell-quoted, and do not substitute
   `${this.file.path}` inside CLI-option values.
7. **Medium — catalogue cache scope can disagree with runs.** It is keyed by
   workspace folder and settings while discovery uses the first model's
   directory. Relative commands such as `./zw` can resolve differently for
   another model whose run uses its own directory.
8. **Low — catalogue discovery starts outside plugin completion contexts.** The
   provider requests the catalogue before confirming that the cursor is at a
   plugin name or option location.
9. **Low — start-failure diagnosis is partial.** The probe checks only whether
   the first command token is locatable. Present-but-not-executable programs or
   failures in later parts of a composite configured command fall through to
   ordinary task/shell errors rather than the targeted attempted-command/PATH
   diagnosis.

### Post-audit continuation

The findings were processed one by one after the independent audit:

- **Finding 1 remains blocked.** The exact versioned dependency and local-link
  development arrangement were explicit instructions. CI cannot install until
  `@zenwave360/dsl@1.9.0-SNAPSHOT` is published; committing a path dependency or
  a stub would violate those instructions.
- **Finding 2 resolved in `44285e3`.** Generated tasks pass an executable and
  strongly quoted arguments to VS Code; displayed commands quote shell
  metacharacters, paths, and embedded values safely.
- **Finding 3 resolved in `c50838a`.** CI now packages first, installs that VSIX
  for the desktop test, and loads the extracted VSIX contents in the browser
  host before publishing.
- **Finding 4 resolved in `1fa4f3b`.** Verification recursively inventories all
  source files below `resources/` and `syntaxes/`. A temporary newly added asset
  was removed from a copied VSIX and the verifier rejected it as expected.
- **Finding 5 resolved in `2164c70`.** The shipped catalogue is returned on the
  first request while the installed catalogue loads asynchronously and replaces
  it when available.
- **Finding 6 resolved in `8d10266`.** CLI options preserve source display and
  order, execute with semantic values, receive strong argument quoting, and
  substitute `${this.file.path}`.
- **Finding 7 resolved in `518df1d`.** Catalogue cache identity includes the
  model working directory used by both discovery and runs.
- **Finding 8 resolved in `9723ff0`.** Completion establishes a plugin-name or
  plugin-option context before requesting the catalogue.
- **Finding 9 resolved in `07c4157`.** Preflight executes the complete configured
  command prefix with `-h json` and reports the attempted command, working
  directory, environment, PATH, and process error on failure.

After these follow-ups, 33 tests, typecheck, lint, both bundles, strict validation
of all nine OpenSpec items, and final 19-file VSIX packaging/verification passed.
The packaged desktop/browser host launch itself remains an external CI or human
verification item.

## Interactive feedback and startup-delay investigation (2026-09-16)

The human confirmed that the echoed CLI string is acceptable. Remaining tracked
documentation edits, the commented fixture Maven import, generated fixture
OpenAPI output, and this report were included in the follow-up commit. Temporary
VSIX/archive files, npm cache, audit scratch notes, and the timing script remain
untracked and were not deleted.

Every Run currently awaits `processService.probe` before calling
`vscode.tasks.executeTask` (`src/sdk/feature.ts:365`). The probe invokes the full
SDK catalogue command `jbang zw -h json` (`src/node/sdk-process.ts:94`), without
reusing the authoring catalogue cache. Thus generation starts the SDK a second
time after preflight has already launched and exited a JVM.

Measured outside the debugger against the fixture directory, using the same
`NodeSdkProcessService.probe` implementation:

- Inherited environment: 12.011 s, 7.735 s, 8.202 s.
- Git Bash login shell: 9.287 s, 9.075 s, 8.744 s.
- Fresh fixture parses: 261.8 ms, 69.7 ms, 56.3 ms; Run normally uses the cached
  document parse.

All six preflights succeeded. These checks demonstrate a real 8–12-second
pre-task cost independent of F5, not the precise timing of the human's click.
No runner behavior was changed as part of this diagnostic request. A follow-up
can share/cache successful preflight/catalogue results by command, working
directory, and environment, with explicit invalidation and retry behavior.
Strict validation of all nine OpenSpec items passed before committing.
