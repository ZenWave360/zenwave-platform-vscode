## Purpose

Connect VS Code to the ZenWave language server — picking a transport the current
host can actually use, surviving its absence gracefully, and giving the rest of
the extension one place to ask the server questions.

## ADDED Requirements

### Requirement: The extension connects to a language server when the host can run one
The extension SHALL start a language client for `zdl` and `zfl` documents when
the current host has a usable transport, and SHALL continue to function without
one when it does not.

#### Scenario: Opening a model on the desktop
- **GIVEN** desktop VS Code with the extension installed and nothing else
  installed by the user
- **WHEN** the user opens a `.zdl` file
- **THEN** the language server that ships with the extension is started, and the
  document is served by it

#### Scenario: Opening a model with no server available
- **GIVEN** a host where no language server can be started
- **WHEN** the user opens a `.zdl` file
- **THEN** the file is still syntax highlighted and editable, and nothing in the
  editor reports an error

#### Scenario: The server fails to start
- **GIVEN** a host where starting the server fails
- **WHEN** the user opens a model file
- **THEN** the editor keeps working without server-backed features, and the
  reason for the failure is recorded in the ZenWave output channel

#### Scenario: The server crashes while editing
- **GIVEN** a running server that terminates unexpectedly
- **WHEN** the user continues editing
- **THEN** the extension reports that the server stopped and lets the user
  restart it, without the editor becoming unresponsive

### Requirement: The extension comes alive for a workspace that has an architecture
The extension SHALL start when the workspace has a ZenWave architecture, without
the user first opening a model document, and SHALL start when the user opens the
architecture manifest itself.

#### Scenario: Opening a configured workspace
- **GIVEN** a workspace carrying ZenWave configuration
- **WHEN** the user opens it and goes to the ZenWave views without opening any
  model file
- **THEN** the extension is running and the views have content

#### Scenario: Opening the manifest
- **GIVEN** a user who opens the architecture manifest as their first ZenWave
  file
- **WHEN** the document is displayed
- **THEN** the extension is running and treats it as a ZenWave document

#### Scenario: A workspace with nothing ZenWave in it
- **GIVEN** a workspace with no ZenWave configuration and no model files
- **WHEN** the user works in it
- **THEN** the extension does not start

### Requirement: The architecture manifest is a document the server serves
The extension SHALL include the resolved architecture manifest among the
documents it asks the language server about, so that whatever the server offers
for it reaches the editor.

#### Scenario: Working on the manifest
- **GIVEN** a connected server and the architecture manifest open
- **WHEN** the user hovers a declaration in it, or navigates from one
- **THEN** they get whatever the server provides for that document, as they would
  in a model file

#### Scenario: A mistake in the manifest
- **GIVEN** a manifest referring to something that cannot be resolved
- **WHEN** the server reports it
- **THEN** the problem appears in the editor on the manifest

#### Scenario: Other files of the same kind
- **GIVEN** a workspace full of unrelated YAML
- **WHEN** the user opens one of those files
- **THEN** it is not treated as a ZenWave document

**Rationale:** the server already has a language module for the manifest, with
hover, navigation, diagnostics and a hierarchy. A client whose document selector
covers only `zdl` and `zfl` leaves all of that unreachable — and the manifest is
the document a user is most likely to be editing when they get it wrong.

### Requirement: Server-backed language features come from the server
Where the server advertises a language feature, the extension SHALL surface it
rather than providing its own. Features the server does not advertise SHALL
simply be absent.

#### Scenario: Diagnostics on an invalid model
- **GIVEN** a connected server and a `.zdl` file with an unknown field type
- **WHEN** the user edits the file
- **THEN** the problem is reported in the editor at the offending location

#### Scenario: Navigating to a definition
- **GIVEN** a connected server and a ZDL entity referenced from a service
- **WHEN** the user invokes Go to Definition on the reference
- **THEN** the editor navigates to the entity declaration

#### Scenario: A feature the server does not offer
- **GIVEN** a server that advertises no formatting support
- **WHEN** the user invokes Format Document on a model file
- **THEN** nothing is reformatted and no error is raised

### Requirement: One architecture manifest is resolved per workspace
The extension SHALL resolve at most one ZenWave architecture manifest for the
whole workspace, SHALL prefer a location the user has configured over any it
finds by itself, and SHALL pass the manifest it resolved to the server when the
connection is initialised. The server SHALL be told when the resolved
configuration changes.

#### Scenario: One folder holding several repositories
- **GIVEN** a workspace that is a single folder containing several checked-out
  repositories side by side — one holding the architecture and its flows, the
  others holding the models that belong to it
- **WHEN** the language server starts
- **THEN** it is initialised with the one manifest for that workspace, and models
  in any of those repositories are understood as part of it

#### Scenario: A single repository opened on its own
- **GIVEN** a workspace that is one repository, containing an architecture
  manifest
- **WHEN** the language server starts
- **THEN** it is initialised with that manifest, without anything outside the
  repository having to be present

#### Scenario: Configuring where the manifest is
- **GIVEN** a workspace where the user has set `zenwave.workspace.manifest` to a
  path
- **WHEN** the language server starts
- **THEN** that manifest is the one used, and nothing is searched for

#### Scenario: A workspace that carries its own ZenWave configuration
- **GIVEN** a workspace folder containing a ZenWave configuration file that names
  a project manifest, and no manifest setting
- **WHEN** the language server starts
- **THEN** the manifest that configuration names is the one used

#### Scenario: A model with no workspace configuration at all
- **GIVEN** a `.zdl` file opened outside any configured workspace
- **WHEN** the language server starts
- **THEN** it starts without a manifest, and single-file features still work

#### Scenario: The configuration is edited
- **GIVEN** a running server initialised from a resolved manifest
- **WHEN** the user edits the configuration that resolved it, or the manifest
  itself
- **THEN** the server is made aware of the change without the user restarting
  VS Code

#### Scenario: Finding out which manifest was chosen
- **GIVEN** a user whose models are not being understood as part of their
  architecture
- **WHEN** they open the ZenWave output channel
- **THEN** it states which manifest was resolved, and how

**Rationale:** a manifest describes an organisation's architecture, and a
workspace holds one. The shape it is written for is a folder holding several
checked-out repositories side by side, where the architecture is one of them —
so resolution is a property of the workspace, not something rediscovered from
whichever file happens to be open.

### Requirement: Model content is resolved by the server, not fetched by the extension
The extension SHALL NOT resolve, download or read model content on the manifest's
behalf, and SHALL NOT decide which source that content comes from. Where content
lives, and in what order candidates are tried, SHALL follow what the manifest
declares.

#### Scenario: Service repositories checked out locally
- **GIVEN** a manifest whose declared order prefers workspace content, with its
  service repositories present alongside it
- **WHEN** models are resolved
- **THEN** they are read from the workspace, and nothing is requested over the
  network

#### Scenario: A service repository that is not checked out
- **GIVEN** a manifest whose declared order allows a remote source, and a service
  repository the user does not have
- **WHEN** models are resolved
- **THEN** the remote source is tried, because that is the order the manifest
  declares — not because the extension asked for it

#### Scenario: Reviewing an architecture in the browser
- **GIVEN** a user who opens only the architecture repository in a browser-based
  VS Code, where no other repository is present to read from
- **WHEN** they open a flow that refers to models in those repositories
- **THEN** the declared order falls through to whatever remote source it names,
  without the extension having to ask for remote resolution

#### Scenario: Content that cannot be reached
- **GIVEN** an artefact that none of the manifest's declared sources can reach
- **WHEN** a model referring to it is opened
- **THEN** it is reported as unresolved, rather than as a broken model

**Rationale:** the manifest already declares an ordered list of sources and
advances past one that cannot produce the content. That is what makes the browser
work without a special case: the workspace source simply finds nothing and the
next source is tried. An extension that forced a source would be second-guessing
a specification that already covers it.

### Requirement: The user can pin which source content comes from
The extension SHALL let the user restrict resolution to one of the sources the
manifest declares, and SHALL default to the manifest's own declared order.

#### Scenario: Working against published content deliberately
- **GIVEN** a user with service repositories checked out, who wants to see what
  the published versions say
- **WHEN** they pin resolution to the manifest's remote source
- **THEN** content comes from there, and their local checkouts are not consulted

#### Scenario: Pinning a source the manifest does not declare
- **GIVEN** a manifest that declares only a workspace source
- **WHEN** the user pins a source the manifest does not declare
- **THEN** they are told that source is not active for this manifest, rather than
  models silently failing to resolve

#### Scenario: The ordinary case
- **GIVEN** a user who has pinned nothing
- **WHEN** models are resolved
- **THEN** the manifest's declared order is used

### Requirement: The extension supplies credentials when the server asks for them
Where the server needs a credential to reach content, the extension SHALL obtain
it on request — from the editor's own authentication providers where the host is
one they cover, and otherwise from credentials the user has given the extension
to keep. The extension SHALL NOT require the user to record a secret in settings
that are shared through the repository.

#### Scenario: A private repository on the desktop
- **GIVEN** a manifest whose remote source is a private GitHub repository
- **WHEN** the server needs that content and asks for a credential
- **THEN** the user is asked to sign in if they have not already, and the content
  resolves

#### Scenario: Already signed in, in the browser
- **GIVEN** a user working in a browser-based VS Code where they are already
  signed in to the host serving the content
- **WHEN** the server asks for a credential
- **THEN** the existing session is used, without asking them to paste a token

#### Scenario: A source the editor has no provider for
- **GIVEN** a manifest whose source is a private artefact repository the editor
  has no sign-in for
- **WHEN** the server asks for a credential
- **THEN** the credential the user has stored with the extension is supplied, and
  the user has a way to record and to replace it

#### Scenario: A credential that has expired
- **GIVEN** content that resolved earlier in the session with a credential that
  has since expired
- **WHEN** the server asks again
- **THEN** a current credential is obtained without the user restarting the
  server or the window

#### Scenario: No credential to give
- **GIVEN** content behind a credential the user has not provided and declines to
  provide
- **WHEN** the server asks
- **THEN** it is told no credential is available, that content resolves as
  unreachable, and the editor keeps working

#### Scenario: Keeping secrets out of the repository
- **GIVEN** a user setting up access to a private source
- **WHEN** they follow what the extension offers
- **THEN** nothing they are asked to do puts the secret in a file that is
  committed with the project

### Requirement: A credential is only released to the host it was meant for
The extension SHALL release a credential only where the request's **origin** —
its scheme, host and port taken together — is one the user authorised for that
credential, compared as a whole rather than as text appearing somewhere in the
address. It SHALL NOT send a credential held for one origin to another, SHALL
treat a redirect to a different origin as a different origin, and SHALL refuse
and record anything that does not match.

#### Scenario: A manifest pointing somewhere unexpected
- **GIVEN** an opened repository whose manifest declares a source on a host the
  user has never authorised
- **WHEN** the server asks for a credential for that host
- **THEN** no credential is released, and the refusal is recorded in the output
  channel

#### Scenario: Two sources, two credentials
- **GIVEN** a workspace with credentials for two different hosts
- **WHEN** content is fetched from each
- **THEN** each request carries only the credential belonging to that host

#### Scenario: A lookalike host
- **GIVEN** a credential authorised for a host, and a request to a different host
  whose address contains that host's name
- **WHEN** the credential is asked for
- **THEN** it is refused

#### Scenario: Redirected elsewhere
- **GIVEN** a request to an authorised origin that is redirected to another
- **WHEN** the redirected request is made
- **THEN** the credential does not travel with it unless that origin is
  authorised too

**Rationale:** a manifest is a file in a repository, and opening a repository is
not a decision to trust it. Without this, a manifest could name a source on any
host and be handed a token for it — the content-resolution path would become a
way to exfiltrate a credential from anyone who opened the project.

### Requirement: Language features respect workspace trust
The extension SHALL NOT start a language server, resolve content, or release a
credential in a workspace the user has not trusted, and SHALL say plainly what is
unavailable for that reason.

#### Scenario: Opening an untrusted repository
- **GIVEN** a repository opened in Restricted Mode
- **WHEN** the user opens a model file in it
- **THEN** no language server is started and nothing in the workspace is fetched,
  while highlighting and editing work as usual

#### Scenario: Being asked for a secret in an untrusted workspace
- **GIVEN** a workspace the user has not trusted
- **WHEN** something would otherwise ask for a credential
- **THEN** nothing is asked and nothing is released

#### Scenario: Granting trust
- **GIVEN** an untrusted workspace the user then trusts
- **WHEN** trust is granted
- **THEN** language features become available without reloading the window

#### Scenario: Knowing what is held back
- **GIVEN** a user in Restricted Mode wondering why nothing works
- **WHEN** they look
- **THEN** they are told that trusting the workspace is what enables it

**Rationale:** the platform does not do this for us. Restricted Mode blocks
tasks, which covers running a plugin, and blocks neither a spawned process nor
the authentication API — so a repository nobody has trusted could otherwise start
a server, fetch from addresses its own manifest names, and prompt for a GitHub
sign-in. The extension's manifest currently promises only that code generation is
limited; that promise has to grow with this change.

### Requirement: A workspace with no manifest still works as far as it can
Where no architecture manifest is resolved, the extension SHALL still offer
everything that does not depend on one, and SHALL NOT present manifest-backed
features as broken.

#### Scenario: A service repository opened on its own
- **GIVEN** a browser-based VS Code with a single service repository open, and no
  manifest in it
- **WHEN** the user opens a `.zdl` file
- **THEN** the file is highlighted, and single-document language features work,
  with no architecture context offered

#### Scenario: Absolute references still resolve
- **GIVEN** a model with no manifest whose document refers to another document by
  an absolute location
- **WHEN** the model is loaded
- **THEN** that reference is followed, because the document asked for it directly
  rather than through the manifest

#### Scenario: Features that need an architecture
- **GIVEN** a workspace with no manifest
- **WHEN** the user looks for architecture-backed views
- **THEN** they say no architecture manifest is configured, and how to configure
  one

### Requirement: ZenWave-specific requests are available to feature code
The extension SHALL provide one way for feature code to issue ZenWave's
server-specific requests, and SHALL answer with an explicit "unavailable" —
rather than hanging or throwing — when there is no server, when the server does
not support the request, or when the request fails.

#### Scenario: A panel asking the server for a view
- **GIVEN** a connected server that supports a ZenWave-specific request
- **WHEN** feature code issues that request for an open document
- **THEN** it receives the server's result

#### Scenario: Asking with no server connected
- **GIVEN** a host with no language server
- **WHEN** feature code issues a ZenWave-specific request
- **THEN** it is told the server is unavailable, promptly, and can show its own
  empty state

#### Scenario: Asking for something this server version does not support
- **GIVEN** a connected server that does not advertise the requested capability
- **WHEN** feature code issues that request
- **THEN** it is told the request is unsupported, distinguishably from the server
  being absent, and the fact is recorded in the output channel

**Rationale:** the panels in `004` and `005` are the callers. Each must be able to
tell "no server here" from "server too old" from "that document is broken",
because those are three different things to tell the user.

### Requirement: Server state is visible and controllable
The extension SHALL show, in the editor itself, whether ZenWave's language
features are available and why not when they are not. It SHALL publish whether a
language server is connected as a context key usable in `when` clauses, SHALL
record the chosen transport and the server's lifecycle in its output channel, and
SHALL offer a command to restart the server.

#### Scenario: Working with no server
- **GIVEN** a model file open in a host where no server is running
- **WHEN** the user is editing
- **THEN** the editor itself indicates that ZenWave language features are
  unavailable, without them having to open the output channel to discover it

#### Scenario: Reaching the detail
- **GIVEN** that indication
- **WHEN** the user acts on it
- **THEN** they arrive at the reason, and at whatever they can do about it

#### Scenario: A reduced host
- **GIVEN** a browser-based VS Code, where code generation can never work
- **WHEN** the user is editing a model
- **THEN** it is evident that this host offers less than the desktop one, rather
  than the missing features being silently absent

**Rationale:** almost every failure in this extension is expressed by something
not being offered — no lens, no command, an empty tree. That is the right
behaviour and it leaves a user unable to tell a reduced environment from a broken
one. One visible indication of state is what makes the silence legible.

#### Scenario: Reading what happened at activation
- **GIVEN** the extension has activated
- **WHEN** the user opens the ZenWave output channel
- **THEN** it states which transport was chosen and whether the server started

#### Scenario: Restarting after a failure
- **GIVEN** a server that failed to start, or that the user has pointed at a
  different build
- **WHEN** the user invokes the ZenWave restart command
- **THEN** the extension attempts to start the server again without reloading
  the window

#### Scenario: Hiding a control that needs the server
- **GIVEN** a feature that only works with a connected server
- **WHEN** no server is connected
- **THEN** that feature's controls are not offered

### Requirement: The server connection is configurable
The extension SHALL let the user override how the server is launched and how much
protocol traffic is logged, through `zenwave.lsp.enabled`,
`zenwave.lsp.serverPath` and `zenwave.lsp.trace.server`, overridable per
workspace.

#### Scenario: Pointing at a locally built server
- **GIVEN** a contributor who has built the language server locally and sets
  `zenwave.lsp.serverPath` to it
- **WHEN** the extension starts the server
- **THEN** it launches the one the user specified rather than the one it ships
  with

#### Scenario: Diagnosing a protocol problem
- **GIVEN** a user asked to provide a trace for a bug report
- **WHEN** they raise `zenwave.lsp.trace.server` and reproduce the problem
- **THEN** the protocol exchange appears in the output channel

#### Scenario: Turning the server off
- **GIVEN** a user who sets `zenwave.lsp.enabled` to off
- **WHEN** they open a model file
- **THEN** no server is started, and the editor behaves as it does on a host with
  no server available
