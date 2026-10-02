# 002 — Design

## Context

Two reference points constrain this, and they disagree in one place.

**IntelliJ** (`ZdlRunPluginLineMarkerContributor`, `ZenWaveSDKTerminalRunner`)
walks the PSI tree for `RULE_plugin_name`, assembles a single command string, and
sends it to a terminal it reuses per working directory. It is the behaviour users
already expect, and its assembly rules are the de-facto contract — the delta spec
restates them deliberately, because until now they existed only as Kotlin.

**`zdl-vscode`** had none of this. There is nothing to carry over.

The disagreement is the runner. IntelliJ reuses a terminal keyed by working
directory, using a hand-rolled search that VS Code has no equivalent for and does
not need — see the decision below.

What makes this change cheap: `@zenwave360/dsl`'s `parseZdl` already returns a
`locations` map alongside the model, keyed by paths like `pluginsList.<n>`, so the
extension does not need to parse ZDL to know where a lens goes. See
`docs/architecture.md` on why parsing stays upstream.

## Goals / Non-Goals

**Goals:**

- Parity with IntelliJ's Run gutter icon, including the command-assembly rules.
- Plugin and option completion, from a catalogue shipped with the extension (see
  "The installed SDK is not asked, for now").
- As little upstream dependency as possible: this is the change that needs the
  least of it, though not none — see the risks.
- Honest gating in the web host, where `zenwave-sdk` can never run.

**Non-Goals:**

- **A documentation assistant.** There is real documentation and there are real
  examples, and neither is written for "I am looking at a plugin block and do not
  know what to put in it". Serving that well is its own effort — an MCP server or
  similar over the existing material — and it belongs wherever that material
  lives, not in an editor extension. What this change does is narrower and
  available now: surface what the SDK already reports, and link to the site.
- **Validating** plugin names and options against the SDK. Completion suggests
  what the SDK offers; reporting a wrong option as a problem in the editor is
  diagnostics, and belongs to the language server.
- A tree view or run-configuration UI for plugins.
- Running plugins declared anywhere other than a ZDL `config { plugins { … } }`
  block. ZFL has no plugin block.
- **Telling the user a run succeeded.** There is no notification, no summary of
  what was generated, no reveal of the target folder and no diff. A zero exit in
  the terminal is the whole of it, and the user goes and looks.

  This is a decision, not an omission. What a successful generation should give
  the user is a real question nobody has answered yet, and a notification
  invented here would be a guess that later has to be unpicked. The spec requires
  only the floor — that generated files appear without the user making them
  appear — which the editor's own file watching should already provide. It is
  specified because it is the thing that would be embarrassing to get wrong, not
  because it is hard.

## Decisions

### Plugin discovery comes from `@zenwave360/dsl`, not from a TypeScript parser

`parseZdl` returns `locations` entries of the form

```
pluginsList.<n>          → [startIndex, endIndex, startLine, startCol, endLine, endCol]
pluginsList.<n>.name     → …
pluginsList.<n>.disabled → …   (present only when the plugin is disabled)
```

so the lens position, the plugin name, the disabled flag, the config options and
the CLI options are all readable from the parsed model.

**The inherit flag is a trap.** The grammar is
`plugin_options: LPAREN plugin_options_inherit RPAREN`, so the syntax is
`MyPlugin (inherit false) { … }` — there is no nested `options { }` block, and an
earlier draft of this spec invented one. Worse, the listener stores the rule's
`.text`, so `parseZdl` reports `options.inherit` as a **string** when the clause
is present (`"inheritfalse"` in the current Kotlin/JS build; whitespace is not
preserved) and the boolean `true` when it is absent. Code
that reads it for truthiness therefore always inherits, which is the wrong answer
silently. IntelliJ avoids this by testing the PSI token rather than the model
field. Either interpret the string, or ask upstream for a boolean; do not trust
the field's shape.

Alternatives rejected:

- **A regex or brace scanner in TypeScript.** This is exactly the "TypeScript
  grows an opinion about what a model means" failure `AGENTS.md` warns about, and
  it would drift from the grammar the moment ZDL changes.
- **LSP CodeLens.** Correct in the long run, and the natural home once
  `zenwave-lsp` is real — but it would make the one unblocked feature depend on
  the one blocked component. Worth revisiting after `003-lsp-client`; the spec is
  written so that moving discovery to the server changes nothing observable.

Line and column are 1-based / 0-based respectively in that tuple (ANTLR's
convention), which is not VS Code's. Getting that wrong puts the lens one line
off, so it is worth a test rather than a careful read.

### The runner is a VS Code task, not `terminal.sendText`

Already settled in `openspec/project.md`; restated here with the reason, because
this is the change that makes it real.

A `ShellExecution` task gives the real terminal IntelliJ users expect *plus* exit
codes, cancellation, problem matchers, and a re-runnable entry in Run Task. Raw
`terminal.sendText` gives a terminal and nothing else — in particular no way to
know whether generation succeeded, which the spec requires.

**IntelliJ's terminal-picking algorithm is not ported, because it solves a
problem VS Code does not have.** `ZenWaveSDKTerminalRunner` looks for a terminal
named "ZenWave SDK", in the right working directory, with nothing typed into it
and no process running — and otherwise creates one, `cd`s and renames it. Every
one of those conditions exists because IntelliJ's terminal tool window is
general-purpose and the user types into it, so the runner must avoid hijacking
one that is in use.

A VS Code task terminal is owned by the task system. `ShellExecution` takes a
`cwd`, so there is no `cd`; the terminal is named after the task, so there is no
rename; and re-running a task that is still running is VS Code's decision, not
ours. Porting the algorithm would be porting a workaround.

**Granularity: a task per plugin, with a dedicated panel.** `TaskPanelKind`
offers `Shared` (one panel across tasks), `Dedicated` (one per task, reused
across its runs) and `New` (one per execution), and "per task" means per
`TaskDefinition`.

Putting only the working directory in the definition would reproduce IntelliJ
exactly — one terminal per model directory — but it would make every plugin in a
file the *same task*, and a user could then neither write a `tasks.json` entry
for one plugin nor bind a key to it. That re-runnability is one of the reasons
for choosing the Tasks API in the first place, so it is not worth trading away
for terminal grouping.

So the definition carries the plugin, its model file, and the assembled command,
and the panel is `Dedicated`: the same command line reuses one terminal; a
different command opens another. Two declarations of the same plugin type with
different options are different commands, so they can run at the same time.

A custom task *type* (`zenwave-sdk`) rather than an anonymous task, so the run
shows up as a ZenWave task and users can bind or re-run it.

**The definition's identity is the command line.** VS Code derives a task's
identity, and so its dedicated terminal, from *every* property of the
definition. Putting the assembled command there is the reuse heuristic: Run
again with the same command, same terminal; change an option, new command, new
terminal. A hand-written `tasks.json` entry of just `plugin` and `file` is still
runnable: the command is assembled when that entry is first resolved.

### The installed SDK is not asked, for now

This supersedes the catalogue and environment sections below wherever they disagree.

Implemented as designed, asking the installed SDK (`jbang zw -h json`) took 8–12
seconds per invocation, started a JVM the user had not asked for, and was also
run before every plugin run as a "can the command start" probe. When the
catalogue should be refreshed was never really settled: an earlier version asked
on workspace startup and plugin activation, the one after that on first
completion.

So completion and hover use only the catalogue generated by release automation,
and nothing starts the SDK except the user's Run. A missing command is found by
looking the executable up on the inherited PATH, which costs nothing; through a
login shell, whose PATH only running it would reveal, it is diagnosed from exit
status 127 after the run.

Still open: whether an installed SDK should ever be asked, and when — an explicit
refresh command, a cache persisted across sessions keyed by SDK command and
version, or not at all. Its benefit is real (a workspace's own plugins, the exact
options of the version in use); it has to be weighed against a JVM start.

### The plugin catalogue is a second, different way of running the SDK

Running a plugin is fire-and-forget into a terminal. Asking the SDK what it
offers is the opposite: a short process whose **stdout is the answer**, invoked
by the editor rather than by the user, and never shown to them.

IntelliJ gets it by appending `-h json` to the configured command and parsing
`{"plugins": [{"configClassName", "options": {…}}]}`. The same command serves
here, so the two IDEs suggest the same things.

Two consequences worth naming. It is a *second* execution path, so the trust and
capability checks have to be applied to it deliberately rather than inherited
from the runner. And it must never be on the critical path of a keystroke: the
first `jbang` invocation downloads the world, and a completion provider that
awaits it would freeze the editor for a minute. Resolve in the background, answer
with nothing until ready.

### Two execution paths, one environment decision

A task inherits the extension host's environment — `ShellExecutionOptions.env` is
documented as merged with "the parent process' environment" — and the extension
host inherits whatever launched the editor. That is the Windows user and system
path, or the environment of the shell the editor was started from. It is **not**
what a shell profile sets up: a version manager that exports its path in
`~/.bashrc` is invisible to a task whose shell does not load that profile.

Two options are enough to cover everybody, and they are not the obvious two:

| | |
| --- | --- |
| **Default** | The task runs with the inherited environment |
| **Optional** | The task runs through a shell that loads the user's profile |

The second uses `ShellExecutionOptions.executable` and `shellArgs` to run the
task in a login shell. An explicit ZenWave shell setting wins, but requiring a
second copy of the user's existing VS Code terminal preference is needless:
when the setting is empty, `vscode.env.shell` supplies the preferred terminal
shell. The argument convention is selected by shell family (`-l -c` for POSIX
shells, PowerShell command switches); other shells are refused, see "Values are
quoted for the shell". It keeps everything the Tasks API was chosen for.

**Rejected: sending the command to the user's terminal.** It would also pick up
their profile, and it gives back exactly what `terminal.sendText` cost us — no
exit code, no cancellation, no problem matcher, no re-run. Trading the reason for
the decision away to solve a path problem is a bad deal when the task can use the
same shell anyway.

Whatever is chosen must apply to **both** paths. Running a plugin goes through a
shell; asking for the plugin catalogue captures stdout from a process with no
shell at all. Left alone they resolve the command differently, and the symptom —
Run works, completion silently does not — is close to undiagnosable.

And a not-found must be diagnosed rather than surfaced as whatever the shell
says. It is the single most likely first-run failure, and the difference between
naming it and not is the difference between thirty seconds and an afternoon.

### A shipped catalogue, so the browser can still author

Code generation cannot work in the browser and never will. Writing the
declaration that configures it has no such excuse — and the plugins block is
precisely the part of a ZDL file nobody writes from memory. An earlier draft left
the web host with no completion and no explanation at all, which made models
unauthorable there for no reason other than that the runner happened to be the
source of the catalogue.

So the extension ships the catalogue of a standard release and falls back to it
wherever the installed SDK cannot be asked — the browser, a missing `jbang`, a
first run still downloading.

Three things keep that honest:

- **The installed SDK always wins**, and the two are never merged. A workspace
  with plugins of its own must not see them shuffled together with a stale list
  where the user cannot tell which is which.
- **The user can tell which they are seeing.** A suggestion describing a release
  they are not using is helpful when labelled and misleading when not.
- **A plugin absent from both is absent.** Nothing is invented for it.

The cost is staleness: a shipped catalogue is a snapshot, and it ages between
extension releases. That is acceptable for a floor and unacceptable as an answer,
which is what the precedence rule encodes. Regenerating the snapshot belongs to
the release process — it is exactly the "a new asset" case `008` was written for.

### Where the explanation appears

The same catalogue answers three questions — what may I write here, what does
this mean, and what would running it do. Completion covers the first, this covers
the second, and the Run lens covers the third.

There are three surfaces, not two, and an earlier draft of this design dismissed
one of them too quickly by talking only about CodeLens. Besides a hover and a
lens row above the declaration, a decoration can be rendered **after the code on
the same line** — which is how inline git blame works, and it is unobtrusive when
it is shown only for the line the cursor is on.

Hover is the primary surface, because it is asked for rather than always present,
and because what there is to say about an option — what it is for, its type, its
default, the values it allows — does not fit at the end of a line. The inline
decoration is a reasonable addition for the plugin name alone, where one short
phrase is the whole of it. What is *not* reasonable is a second lens row: the row
above a plugin declaration belongs to Run, and the control that does something
should not have to compete with a label.

The spec is written in terms of the user asking and being told, so it does not
settle this. Start with hover; add the inline line if reading a plugins block
still feels like consulting a manual.

### The explanation and the link are reported, never derived

Linking out rather than embedding is deliberate: the documentation on the ZenWave
site is written for people reading documentation, not for a tooltip, and
paraphrasing it here would create a second copy that drifts.

But the link cannot be constructed from a plugin's name, and the reason is
stronger than broken URLs. **The catalogue reports plugins a workspace's own team
wrote**, not only the ones that ship with the SDK. A convention derived from a
name would be right for the built-ins and confidently wrong for everything else —
and wrong in the direction of sending someone to a page about a different plugin.

So the documentation location is data, and it comes from the same place the
options come from. That is an addition to what the SDK reports today, tracked in
`zenwave-specs`.

If the language server later fronts the catalogue rather than the extension
invoking the CLI directly, nothing here changes observably — which is a good sign
that the requirement is written at the right level.

### The command stays a single string

`zenwave-sdk` options are `name=value` pairs and CLI flags that users copy
between the terminal and the model file. Splitting them into an argv array and
letting `ShellExecution` re-quote would produce a command line the user cannot
paste back, and would fight the `--deps a,b,c` and `option=value` forms.

**Implementation discovery:** `parseZdl` exposes semantic config values, not the
source token text, and it records no source locations for plugin config values.
For example, both `displayName "Orders API"` and `displayName 'Orders API'` are
reported as `"Orders API"` without their delimiters. Exact source preservation
would require a second ZDL lexer, which this design rejects. The observable
contract therefore preserves the parsed value and safely re-quotes whitespace;
it does not promise the source's original quote character. CLI options are
different: the DSL package reports their value text with its quotes intact, so
those can still be appended verbatim.

### Values are quoted for the shell

An earlier draft passed values the user typed as typed, so that they could
contain shell syntax, and relied on workspace trust as the boundary. That was
reversed: trusting a repository to run code generation is not trusting every
value in its models to be a shell command, and a user who clicks Run without
hovering has inspected nothing. **Every value from the model or from settings —
config options, CLI options, injected paths, extra arguments, the configured
command itself — is quoted so that it reaches the SDK as one literal argument.**

Quoting depends on the shell, and only two families are supported:

- **POSIX** (bash, zsh, sh, dash, ksh, fish): safe tokens bare; `name="value"`
  when nothing inside the value expands; otherwise single quotes, `'` as `'\''`.
- **PowerShell**: the same, with `,` and a leading `@` treated as unsafe, single
  quotes doubled, and `& ` before a quoted executable — a quoted string in
  command position is a value, not a call. Windows PowerShell drops double quotes
  inside native arguments, and a batch file such as `jbang.cmd` re-parses what is
  left, so a value containing `"` is refused rather than run.

The shell is the login shell when one is selected, otherwise VS Code's automation
profile, otherwise its preferred terminal shell. **Anything else, `cmd.exe` in
particular, is refused with an explanation.** `cmd.exe` has no quoting that keeps
`%`, `&` and `^` reliably literal; supporting it would mean accepting that a model
value can run a command. A user whose tasks default to `cmd` is told to choose an
automation profile or a login shell.

The command stays one string, so the terminal echoes exactly what ran and what
the lens tooltip showed.

**This compounds with the shell option above.** In a bash shell — which is what a
Windows user with a version manager is most likely to select — the backslash is
an escape character, so a Windows path placed in a single command string loses
its separators. A single command string, Windows paths and a bash shell together
produce a wrong command rather than an error, which is the worst kind. It needs a
fixture of its own rather than a careful implementation.

Windows is where this bites first: `C:\Users\…\My Project\orders.zdl`. Worth a
fixture.

### Gating is checked twice

`zenwave.canRunSdk` hides the lens; the command re-checks on execution, and
workspace trust is checked separately at execution time. `host-capabilities`
already requires this — a context key hides a control, it does not secure it, and
a CodeLens command is invokable programmatically.

Workspace trust is its own axis, not a host capability: a desktop host *can* run
processes while the user has told VS Code not to trust this folder. The
`untrustedWorkspaces: limited` declaration is already in `package.json` and this
change is what it was written for.

## Risks / Trade-offs

- **The assembly rules are duplicated in Kotlin and TypeScript, and have already
  drifted.** `parseZdl` returns option values unquoted and records no source
  range for them, while IntelliJ reads the raw source text — so
  `targetFolder "src"` becomes `targetFolder="src"` there and `targetFolder=src`
  here. Usually equivalent to a shell; not always. The fix is upstream and small
  (record plugin options in `locations`, as the top-level `config` block already
  does), and until it lands the two IDEs can be told apart, which is exactly what
  this risk predicted. Two implementations of one contract will drift. Accepted for now — the alternative
  is blocking on a shared implementation — but this is a strong candidate for the
  `zenwave-specs` store, and eventually for the language server to own outright.
  The spec is written so a user could tell the two apart.
- **`@zenwave360/dsl` is not on the public npm registry.** This was assumed and
  was wrong: `npm view @zenwave360/dsl` returns a 404, and the upstream README
  still says publication is pending.

  It does not block development. Kotlin/JS already produces a complete package at
  `dsl-kotlin/build/js/packages/dsl-kotlin`, so the dependency can be declared by
  version and linked locally, and nothing changes when publication happens.

  It does block two other things, and they should be said out loud rather than
  discovered: a clean checkout cannot `npm install`, and `008`'s pipeline goes
  red the moment this change lands. Publication is on the critical path to
  releasing, not to building.
- **It becomes a shipped runtime dependency**, not a dev one, so it grows the
  bundle and adds a version to keep in step with the language.
- **Parsing on every document change** to place lenses. CodeLens refresh is
  already debounced by VS Code, but a large model re-parsed on every keystroke is
  a plausible source of jank. If it shows up, the answer is caching keyed on
  document version — not a different discovery mechanism.
- **`jbang zw` on first run downloads the world.** The user sees a long silent
  pause. The terminal makes that visible, which is one more argument for the task
  over a hidden process.
