## Purpose

Turn a plugin declaration in a ZDL model into something the user can run without
leaving the editor: a Run affordance on the declaration, a command line assembled
from what the declaration actually says, and a terminal to run it in.

## ADDED Requirements

### Requirement: Every runnable plugin declaration offers a Run action
The extension SHALL present a Run action directly above each plugin declaration
inside a `config { plugins { … } }` block of a ZDL document. A plugin declared
`disabled` SHALL NOT offer one.

#### Scenario: A file with several plugins
- **GIVEN** a `.zdl` file whose `config { plugins { … } }` block declares three
  plugins, each with its own braced body
- **WHEN** the file is open in the editor
- **THEN** a Run action appears above each of the three plugin declarations

#### Scenario: Several plugins of the same type
- **GIVEN** a `.zdl` file whose `config { plugins { … } }` block declares the
  same plugin type more than once, each with its own braced body and options
- **WHEN** the file is open in the editor
- **THEN** a Run action appears above each declaration, and triggering one
  runs that declaration's options

#### Scenario: A disabled plugin
- **GIVEN** a plugin declaration marked `disabled`
- **WHEN** the file is open in the editor
- **THEN** no Run action appears for that plugin, while the other plugins keep
  theirs

#### Scenario: A model with no plugins
- **GIVEN** a `.zdl` file with entities and services but no `config` block
- **WHEN** the file is open in the editor
- **THEN** no Run action appears anywhere in the file

#### Scenario: A file that does not parse
- **GIVEN** a `.zdl` file the user is midway through typing, with an unbalanced
  brace
- **WHEN** the file is open in the editor
- **THEN** Run actions for the parts that could not be read are simply absent,
  and no error is shown to the user

**Rationale:** a half-typed file is the normal state of an editor. A lens that
throws, or an error notification on every keystroke, would make the feature worse
than not having it.

### Requirement: The command line reflects the whole plugin declaration
The Run action SHALL assemble the command from the plugin declaration and the
model file that contains it, using these rules:

- the plugin name is passed as the plugin to run, as the value of the SDK's
  plugin option (`-p`), not as a positional argument;
- the plugin's own config options are passed as `name=value` pairs using the
  value the ZDL parser reports — a string without its quotes, a number as its
  digits — rather than as spelled in the source;
- the enclosing `config` block's options are inherited and passed the same way,
  unless the plugin opts out with `(inherit false)` after its name;
- an option declared on the plugin overrides an inherited option of the same name;
- CLI options declared directly in the enclosing `config` block are inherited
  unless the plugin opts out with `(inherit false)`;
- the effective CLI options are passed in declaration order, with a plugin-local
  CLI option replacing an inherited CLI option of the same name;
- every value that comes from the model or from settings is quoted for the shell
  the command runs in, so that it reaches the SDK as one literal argument and is
  never interpreted by the shell;
- imports that are Maven coordinates (`groupId:artifactId:version`) are collected
  into a single `--deps` argument;
- `zdlFile` defaults to the path of the containing file, unless the declaration
  already sets `zdlFile` or `zdlFiles`;
- `${this.file.path}`, where it appears in any value, is replaced with the path
  of the containing file.

#### Scenario: Inheriting an option from the config block
- **GIVEN** a `config` block declaring `basePackage io.example.orders` and a
  plugin declaring only `targetFolder .`
- **WHEN** the user triggers the plugin's Run action
- **THEN** the command carries both `basePackage=io.example.orders` and
  `targetFolder=.`

#### Scenario: Opting out of inheritance
- **GIVEN** a plugin declared as `MyPlugin (inherit false) { … }` alongside a
  `config` block that sets `basePackage`
- **WHEN** the user triggers that plugin's Run action
- **THEN** the command carries the plugin's own options only, and no
  `basePackage`

#### Scenario: Not opting out
- **GIVEN** a plugin declared without an inherit clause, and one declared
  `(inherit true)`
- **WHEN** the user triggers either Run action
- **THEN** both inherit the enclosing `config` block's options

#### Scenario: A plugin option shadowing an inherited one
- **GIVEN** a `config` block setting `targetFolder .` and a plugin setting
  `targetFolder build/generated`
- **WHEN** the user triggers the plugin's Run action
- **THEN** the command carries `targetFolder=build/generated` once, and not the
  inherited value

#### Scenario: Inheriting a CLI flag from the config block
- **GIVEN** a `config` block declaring `--force` before two plugin declarations
- **WHEN** the user triggers either plugin's Run action
- **THEN** each command carries `--force` once

#### Scenario: Opting out of inherited CLI options
- **GIVEN** a `config` block declaring `--force` and a plugin declared as
  `MyPlugin (inherit false) { … }`
- **WHEN** the user triggers that plugin's Run action
- **THEN** its command does not carry `--force`

#### Scenario: A plugin CLI option shadowing an inherited one
- **GIVEN** a `config` block declaring `--profile=local` and a plugin declaring
  `--profile=test`
- **WHEN** the user triggers that plugin's Run action
- **THEN** the command carries `--profile=test` once and does not carry
  `--profile=local`

#### Scenario: The model file is passed automatically
- **GIVEN** a plugin declaration that mentions neither `zdlFile` nor `zdlFiles`
- **WHEN** the user triggers its Run action
- **THEN** the command carries `zdlFile=` followed by the path of the file the
  declaration is in

#### Scenario: The model file is already named
- **GIVEN** a plugin declaring `zdlFiles orders.zdl,customers.zdl`
- **WHEN** the user triggers its Run action
- **THEN** the command carries that declaration unchanged and no added `zdlFile`

#### Scenario: Maven coordinate imports become dependencies
- **GIVEN** a model importing both `./shared/common.zdl` and
  `io.example:my-plugin:1.2.3`
- **WHEN** the user triggers a Run action in that model
- **THEN** the command carries `--deps io.example:my-plugin:1.2.3`, and the
  relative file import is not passed as a dependency

#### Scenario: Referring to the current file inside a value
- **GIVEN** a plugin option whose value contains `${this.file.path}`
- **WHEN** the user triggers its Run action
- **THEN** the command carries the path of the containing file in place of that
  placeholder

#### Scenario: A quoted option value containing spaces
- **GIVEN** a plugin option declared as `displayName "Orders API"`
- **WHEN** the user inspects or runs its command
- **THEN** the command carries `displayName="Orders API"`, preserving the
  parsed value even though the parser does not expose which quote delimiter was
  used in the source

#### Scenario: A numeric option value
- **GIVEN** a plugin option declared as `maxDepth 3`
- **WHEN** the user inspects or runs its command
- **THEN** the command carries `maxDepth=3`

#### Scenario: A value that looks like shell syntax
- **GIVEN** a plugin config option or CLI option whose value is
  `$(touch generated.txt); echo done`
- **WHEN** the user runs the plugin
- **THEN** the SDK receives that text as the option's value, and no other command
  runs

**Rationale:** a model file is shared through a repository, and trusting a
workspace to run code generation is not the same as trusting every value in it to
be a shell command. Quoting everything makes Run do what its tooltip says.

### Requirement: The user can read the command before running it
The Run action SHALL make the full command line visible without running it, and
the command line SHALL be echoed where the command runs.

#### Scenario: Inspecting before running
- **GIVEN** a Run action displayed above a plugin declaration
- **WHEN** the user hovers it
- **THEN** the complete command line that would be executed is shown

#### Scenario: Seeing what ran
- **GIVEN** a plugin that has just been run
- **WHEN** the user looks at the terminal it ran in
- **THEN** the command line that was executed is visible there, in a form they
  can copy and re-run by hand

#### Scenario: A model in a directory whose name has a space
- **GIVEN** a model file whose path contains a space
- **WHEN** the user triggers a Run action
- **THEN** the command runs against that file, and the command line shown is one
  that would still work if the user pasted it into a shell themselves

### Requirement: Running a plugin runs it in a terminal in the workspace
Triggering a Run action SHALL execute the assembled command in a terminal, with
the directory containing the model file as the working directory. The run SHALL
be cancellable, SHALL report a non-zero exit status to the user, and SHALL be
re-runnable without returning to the model file. A later Run SHALL reuse that
terminal when the assembled command is the same, and SHALL use a new terminal
when the command differs, including two declarations of the same plugin type.
Several different commands SHALL be able to run at the same time.

#### Scenario: Running a plugin
- **GIVEN** a model file at `src/main/resources/model/orders.zdl`
- **WHEN** the user triggers a Run action in it
- **THEN** the command runs in a terminal whose working directory is
  `src/main/resources/model`

#### Scenario: Running the same command again
- **GIVEN** a plugin that has already been run, with its declaration unchanged
- **WHEN** the user runs it again
- **THEN** it runs in the terminal its previous run used

#### Scenario: Running again after editing the declaration
- **GIVEN** a plugin that has already been run, whose options the user has since
  changed
- **WHEN** the user runs it again
- **THEN** it runs with the changed options, in a new terminal

#### Scenario: Two declarations of the same plugin type
- **GIVEN** two runnable declarations of the same plugin type, with different
  options
- **WHEN** the user runs both
- **THEN** each runs in its own terminal, and both run at the same time

#### Scenario: Running plugins from two different models
- **GIVEN** plugins run from model files in two different directories
- **WHEN** both have been run
- **THEN** each ran with its own file's directory as the working directory

#### Scenario: A terminal the user is working in
- **GIVEN** a user with their own terminal open, in the same directory as the
  model
- **WHEN** they trigger a Run action
- **THEN** the command does not run in their terminal

#### Scenario: The SDK fails
- **GIVEN** a plugin whose options are rejected by `zenwave-sdk`
- **WHEN** the user runs it
- **THEN** the failure is visible as a failed run, not reported as success, and
  the SDK's own output remains readable in the terminal

#### Scenario: Seeing what was generated
- **GIVEN** a plugin run that writes files into the workspace
- **WHEN** it finishes
- **THEN** those files are visible in the workspace without the user reloading
  the window, and a generated file already open in an editor shows its new
  content

#### Scenario: Re-running the last generation
- **GIVEN** a plugin that was run a moment ago
- **WHEN** the user re-runs the last task from the command palette
- **THEN** the same command runs again, without reopening the model file

### Requirement: A plugin runs only through a shell its command can be quoted for
The extension SHALL run a plugin only through a POSIX shell (such as bash, zsh or
sh) or PowerShell, whether that is the shell VS Code runs tasks in or the login
shell the user chose. For any other shell, and for a value no quoting can deliver
to the SDK intact in the shell being used, it SHALL refuse to run and say why and
what to change.

#### Scenario: Tasks run in bash or PowerShell
- **GIVEN** VS Code runs tasks in bash, zsh or PowerShell
- **WHEN** the user triggers a Run action
- **THEN** the plugin runs

#### Scenario: Tasks run in cmd
- **GIVEN** VS Code runs tasks in `cmd.exe`, and no login shell is selected
- **WHEN** the user triggers a Run action
- **THEN** nothing is executed, and the user is told that the SDK runs only
  through a POSIX shell or PowerShell and which setting selects one

#### Scenario: A value PowerShell cannot pass intact
- **GIVEN** tasks run in PowerShell, and a plugin option whose value contains a
  double quote
- **WHEN** the user triggers its Run action
- **THEN** nothing is executed, and the user is told which value cannot be passed
  and how to run it instead

**Rationale:** `cmd.exe` has no quoting that reliably keeps a value from being
interpreted, and Windows PowerShell drops double quotes inside arguments to native
commands — which, when the SDK is started through a batch file such as
`jbang.cmd`, hands the rest back to `cmd.exe`. Refusing is the only way to keep
the guarantee that a model value is never run as a command.

### Requirement: The user can make the SDK run with their shell's environment
The extension SHALL run the SDK with the environment it inherits from the editor
by default, and SHALL let the user choose instead to run it through a shell that
loads their own profile. An explicitly configured login shell SHALL take
precedence; otherwise the extension SHALL use VS Code's preferred terminal shell
and the login/command arguments appropriate to that shell family. It SHALL report
a configuration error only when neither shell is usable.

#### Scenario: A tool on the system path
- **GIVEN** a user whose SDK command is on the path their editor was started with
- **WHEN** they run a plugin
- **THEN** it is found, with nothing configured

#### Scenario: A tool installed by a shell version manager
- **GIVEN** a user whose SDK command exists only because their shell profile puts
  it on the path — a version manager, or a shell-specific installation
- **WHEN** they turn on running through their shell
- **THEN** running a plugin finds the command

#### Scenario: Reusing the preferred terminal shell
- **GIVEN** a user who selects login-shell execution, has a preferred terminal
  profile in VS Code, and does not configure `zenwave.sdk.loginShell`
- **WHEN** the extension runs a plugin
- **THEN** it invokes VS Code's preferred terminal shell using that shell
  family's login/command convention

#### Scenario: Overriding the preferred terminal shell
- **GIVEN** a user whose preferred terminal shell differs from the executable
  configured in `zenwave.sdk.loginShell`
- **WHEN** the extension runs a plugin
- **THEN** the explicitly configured shell is used

#### Scenario: No usable login shell
- **GIVEN** login-shell execution is selected, the explicit shell setting is
  empty, and VS Code reports no preferred shell
- **WHEN** the extension tries to run the SDK
- **THEN** it reports that no usable login shell is available

### Requirement: A missing SDK command is diagnosed, not silent
Where the configured SDK command cannot be found, the extension SHALL say so, and
SHALL report what it tried to run and where it looked. It SHALL find this out
without starting the SDK.

#### Scenario: The SDK is not installed
- **GIVEN** a user who has not installed the SDK command
- **WHEN** they trigger a Run action
- **THEN** they are told the command could not be found, and what was tried,
  rather than being left with a shell error they have to interpret

#### Scenario: Installed somewhere the editor cannot see
- **GIVEN** a user whose SDK command works in their own terminal but is not on
  the path the editor inherited
- **WHEN** they trigger a Run action
- **THEN** what they are told is enough to recognise that as the problem, and
  points them at running through their shell

#### Scenario: Not found by the login shell
- **GIVEN** login-shell execution is selected, and the shell cannot find the SDK
  command
- **WHEN** the run ends
- **THEN** the user is told the command was not found through that shell

#### Scenario: Starting a run is not delayed
- **GIVEN** an SDK that takes several seconds to start
- **WHEN** the user triggers a Run action
- **THEN** the terminal opens and the SDK starts once, without a hidden run of
  the SDK before it

### Requirement: The SDK command line is configurable
The extension SHALL let the user configure the command used to invoke
`zenwave-sdk` through the `zenwave.sdk.cliCommand` setting, defaulting to
`jbang zw`, and SHALL let the user append arguments to every run through
`zenwave.sdk.extraArgs`. Both SHALL be overridable per workspace.

#### Scenario: A locally installed CLI
- **GIVEN** a user who has `zw` on their `PATH` and sets `zenwave.sdk.cliCommand`
  to `zw` in their own settings
- **WHEN** they trigger a Run action in any workspace
- **THEN** the command begins with `zw` and not with `jbang zw`

#### Scenario: One project that needs a different SDK
- **GIVEN** a user with a personal default, working in a project that pins a
  different SDK command in its workspace settings
- **WHEN** they trigger a Run action there
- **THEN** the project's command is used, and their default still applies
  everywhere else

#### Scenario: A project-wide extra argument
- **GIVEN** a workspace setting adding an extra argument
- **WHEN** the user triggers any Run action in that workspace
- **THEN** that argument is present in the command line

### Requirement: Plugin declarations are completed from the shipped catalogue
The extension SHALL offer completion for plugin names where a plugin may be
declared, and for the configuration options of the plugin being declared, taken
from the plugin catalogue shipped with the extension.

#### Scenario: Naming a plugin
- **GIVEN** the cursor inside a `config { plugins { … } }` block, where a plugin
  name may be written
- **WHEN** the user asks for completion
- **THEN** the plugins of the shipped catalogue are suggested, and accepting one
  leaves the cursor ready to write its options

#### Scenario: Setting an option on a plugin
- **GIVEN** the cursor where an option of a declared plugin may be written
- **WHEN** the user asks for completion
- **THEN** the options that plugin accepts are suggested, each showing what it is
  for, its type, its default, and the values it allows where it is restricted to
  some

#### Scenario: Options belong to their plugin
- **GIVEN** two plugins declared in the same block, each accepting different
  options
- **WHEN** the user asks for completion inside one of them
- **THEN** only that plugin's options are suggested

**Note:** the installed SDK could report plugins of a workspace's own and the
exact options of the version in use, but asking it means starting a JVM, which
takes seconds. When — if ever — that is worth doing is an open question, recorded
in the design; until it is answered, the shipped catalogue is the only source.

### Requirement: A plugin declaration explains itself where it is written
The extension SHALL show, for a plugin name and for a plugin option in a model,
what the shipped catalogue reports about it, together with a way to reach its
documentation.

#### Scenario: Meeting an unfamiliar plugin
- **GIVEN** a model declaring a plugin the reader has not used
- **WHEN** they ask the editor about it
- **THEN** they learn what the catalogue says it is, and can reach its
  documentation without leaving the editor to search for it

#### Scenario: Understanding an option
- **GIVEN** the cursor on an option inside a plugin declaration
- **WHEN** the user asks the editor about it
- **THEN** they see what it is for, what type it takes, what it defaults to, and
  which values it allows where it is restricted to some

#### Scenario: Something the catalogue does not describe
- **GIVEN** an option the catalogue reports without a description
- **WHEN** the user asks about it
- **THEN** they are shown what is known, and nothing is invented to fill the gap

#### Scenario: Nothing to link to
- **GIVEN** a plugin for which the catalogue reports no documentation
- **WHEN** the user asks about it
- **THEN** what is known is shown and no link is offered, rather than a link
  being constructed that may go nowhere

#### Scenario: Something the catalogue does not know
- **GIVEN** a plugin absent from the shipped catalogue, such as one a workspace's
  own team wrote
- **WHEN** the user asks about it
- **THEN** nothing is explained and nothing is invented

**Rationale:** the gap this closes is the one a newcomer hits first — knowing that
a plugin declaration is where generation is configured, and having no idea which
plugin they need or what it accepts. Completion helps someone who already knows
what they are looking for; this helps someone who does not.

The explanation and the link are both things the catalogue reports, never things
the extension works out. The set of plugins is open, so an editor that guessed
where documentation lives would be right only for the ones that shipped with the
SDK, and confidently wrong for everything else.

### Requirement: Authoring help works on every host, without the SDK
The extension SHALL carry a plugin catalogue generated from a named ZenWave SDK
build by its release automation, and SHALL use it to complete and explain plugin
declarations on every host. The user SHALL be able to tell which SDK build it
describes.

#### Scenario: Authoring a model in the browser
- **GIVEN** a `.zdl` file open in a browser-based VS Code, where the SDK can never
  run
- **WHEN** the user writes a plugin declaration
- **THEN** the plugins and options of the catalogue are suggested and explained,
  so the file can be authored

#### Scenario: Knowing what you are looking at
- **GIVEN** a suggestion or an explanation from the catalogue
- **WHEN** the user considers it
- **THEN** it is evident that it comes from the catalogue shipped with the
  extension, and which SDK version that describes

#### Scenario: A workspace with plugins of its own
- **GIVEN** a workspace using plugins that did not ship with the SDK
- **WHEN** the user asks for completion
- **THEN** those plugins are absent, and this is not presented as their SDK
  being incomplete

### Requirement: Authoring never starts the SDK
The extension SHALL NOT start the SDK, or any other process, to complete or
explain a model.

#### Scenario: Typing through a plugins block
- **GIVEN** a user writing several plugin declarations, asking for completion
  and hovering repeatedly
- **WHEN** they work through the block
- **THEN** no process is started, and every request is answered immediately

#### Scenario: A first run that would download the world
- **GIVEN** an SDK command that has never run on this machine
- **WHEN** the user opens a model and asks for completion
- **THEN** they are answered from the shipped catalogue, and nothing is
  downloaded or started on their behalf

**Rationale:** `jbang zw -h json` took 8–12 seconds per invocation when measured,
and started a JVM the user never asked for. Authoring help that costs that much
would be worse than help that is a release behind.

### Requirement: The Run action is absent where the SDK cannot run
The extension SHALL NOT present a Run action in a host that cannot spawn
processes, and SHALL NOT run a plugin in a workspace the user has not trusted.
In both cases the reason SHALL be discoverable.

#### Scenario: A model opened in vscode.dev
- **GIVEN** a `.zdl` file with plugin declarations, open in a browser-based VS Code
- **WHEN** the file is displayed
- **THEN** it is syntax highlighted as usual and no Run action appears

#### Scenario: Running a plugin where the SDK cannot run
- **GIVEN** a browser-based VS Code, where the SDK can never run
- **WHEN** the user works in a plugins block
- **THEN** they can write and understand the declaration, and nothing offers to
  run it

#### Scenario: A model in a restricted workspace
- **GIVEN** a workspace the user has opened in Restricted Mode
- **WHEN** the user triggers a Run action
- **THEN** nothing is executed, and the user is told the workspace must be
  trusted to run code generation

#### Scenario: Finding out why the Run action is missing
- **GIVEN** a user who expected a Run action and does not see one
- **WHEN** they open the ZenWave output channel
- **THEN** they can see whether this host can run the SDK at all
