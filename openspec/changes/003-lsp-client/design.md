# 003 — Design

## Context

IntelliJ does not have a language *client* in any meaningful sense.
`ZenwaveLspProjectService` constructs `ZenwaveLspServer` **in the same JVM** and
calls it directly — no transport, no process, no serialisation. That is a
legitimate shortcut for a JVM IDE and it is why the client side of the protocol
has never been exercised: VS Code will be the first real consumer of
`zenwave-lsp` over a wire.

Expect to find protocol bugs that IntelliJ's in-process shortcut hides.

What already exists upstream and can be relied on:

- custom requests `zenwave/hierarchy`, `zenwave/forwardReferences`,
  `zenwave/reverseReferences`, `zenwave/organizeZflServices`,
  `zenwave/conceptAt`, `zenwave/workspaceStatus`;
- initialization options shaped `{ zenwave: { configUri, projectManifestUri } }`;
- `zenwave-architecture`'s content-resolution specification, which already says how a
  manifest reaches content in other repositories.

Read as *intended* rather than relied on: `.zenwave/config.yml` naming a project
manifest. The IntelliJ plugin has a provider that reads it, but it is not yet
load-bearing there, so it is a convention this project means to have rather than
one to argue parity from.

What does not exist yet, and blocks implementation:

- **a JVM launcher.** `lsp-jvm` is a library. Something has to speak stdio.
- **`lsp-js`.** `src/` contains a `.gitkeep`. Its Gradle file declares only
  `nodejs()` and depends on `vscode-languageserver` 8.1.0 — the Node build, not
  the browser one.

## Goals / Non-Goals

**Goals:**

- One connection, supervised in one place, that `004` and `005` both consume.
- A transport decision made by construction, as `001` established for
  capabilities — the Node entry knows it is Node.
- Absence of a server is a *state*, not a failure: grammars keep working, and the
  user can find out why.

**Non-Goals:**

- Shipping a JVM. The user brings their own Java, as they already do for
  `zenwave-sdk`.
- Specifying the individual language features. Diagnostics, completion, hover,
  formatting and semantic tokens are whatever the server advertises; this repo
  does not get an opinion, and a requirement per feature would be this repo
  asserting something it does not own.
- Auto-downloading a server artefact from the network.
- The custom requests `004` and `005` need. Those are cross-repo contracts and
  are proposed in the `zenwave-specs` store, not here.

## Decisions

### Transport is chosen by entry point, not sniffed

`src/node/` builds a stdio client; `src/browser/` builds a worker client. Neither
shared code nor the other entry point imports the other's transport.

This is the same rule as `001` and for the same reason: `vscode-languageclient`
splits into `vscode-languageclient/node` and `vscode-languageclient/browser`, and
the node sub-path reaches `child_process`. Importing it from shared code produces
a browser bundle that builds cleanly and dies inside a Web Worker.

`HostCapabilities.languageServer` already exists for this, reported as `none`
since `001` precisely so this change extends a value instead of introducing a
concept. That is why it is a MODIFIED requirement on `host-capabilities` rather
than a new one.

### One server, in JavaScript, shipped with the extension

An earlier draft of this design had the desktop host launch the JVM server and
only the browser use `lsp-js`. That was inferred from `lsp-jvm` being the real
module and `lsp-js` being an empty stub, and from IntelliJ instantiating the
JVM server in-process. It was wrong.

The server is `@zenwave360/lsp-js` in both hosts: a Node child process over IPC
on the desktop, a Web Worker in the browser, from the same JavaScript shipped in
the extension.

Rejecting the JVM on the desktop is a real trade and worth stating. Kotlin/JVM
is faster than Kotlin/JS at the CPU-bound work here — ANTLR parsing, graph
analysis, ELK layout — and a JIT warms up well in a long-lived process. Against
that:

- **Startup.** Node starts in tens of milliseconds; a JVM in hundreds, and
  through JBang the first run spends seconds resolving dependencies. A language
  server that is slow to become ready reads as a broken editor.
- **Prerequisites.** Editing a model stops requiring a JDK at all. That is the
  difference between installing an extension and following an install guide.
- **One implementation.** Two servers are two implementations of the language,
  and the one used less — the browser — is the one that gets tested less and
  breaks quietly. It is the same argument this project applies everywhere else.

Layout is the case that most favours the JVM, and it is computed once per render
rather than per keystroke, so it is not the case to optimise for.

**What would change this answer** is a measurement that does not exist yet:
incremental reparse latency on the largest real model. If that exceeds roughly a
tenth of a second, the trade is worth revisiting — and the answer then is
probably to move work off the critical path rather than to ship a second server.

`zenwave.lsp.serverCommand` survives as the way a contributor points at a locally
built server, not as the mechanism by which ordinary users acquire one.

### Server absence is modelled explicitly, not as a rejected promise

The spec requires callers to distinguish *no server*, *unsupported request* and
*request failed*. A rejected promise flattens all three into one `catch`, and the
panels then cannot say anything useful — the difference between "install Java",
"update the server" and "fix your model" is the entire value of the message.

So the request helper returns a result that names which of those happened. The
shape is code's business; that it is distinguishable is the spec's.

### The manifest is resolved per workspace, configured before it is searched for

IntelliJ's `AncestorZenwaveWorkspaceConfigProvider` walks up from the open file
looking for `.zenwave/config.yml`, which names the project manifest:

```yaml
project-manifest: arcadia-editions-architecture/zenwave-architecture.yml
```

The intended shape is **one folder holding several checked-out repositories**,
which is how `arcadia-editions` is laid out: the folder holds `.zenwave/`, and the
architecture repository and the service repositories are siblings inside it. That
folder is the VS Code workspace; the repositories are ordinary subdirectories that
happen to be git checkouts.

The web host is the same picture with one repository instead of several.

Walking up from the open file still works for both, but it answers a question
nobody asked — the manifest belongs to the workspace, and rediscovering it from
whichever file is open invites two files in the same workspace to disagree. So
resolution is workspace-scoped and layered:

1. a VS Code setting naming the manifest — authoritative, searched for nothing;
2. otherwise a `.zenwave/config.yml` at a workspace folder root;
3. otherwise no manifest, and single-file behaviour.

**A caveat on (2).** `AncestorZenwaveWorkspaceConfigProvider` exists in the
IntelliJ plugin and reads exactly this file, but it is not yet load-bearing
there. So this is a convention the project intends, not a proven cross-IDE
mechanism, and no requirement here should rest on IntelliJ parity through it. It
is second in the order because an IDE-neutral file in the repository is the right
shape for a fact about an organisation's architecture — recorded where every tool
can see it, rather than in one editor's preferences. If it stays aspirational, the
setting carries the feature on its own; the ordering costs nothing either way.

Resolving once per workspace, rather than per document, also means one server
initialisation instead of one per repository. That is the shape the server
already expects: `openWorkspace(manifestUri)` at initialise.

### Content resolution is already solved upstream, and we must not re-solve it

The obvious worry with a multi-repository workspace is how a manifest in the
architecture repository reaches models in the service repositories. The manifest
answers it itself:

```yaml
contentResolution: [workspace, git]
sources:
  workspace: { basePathExpression: "../${owner.repository}" }
  git:       { contentUrlExpression: "${server}/${org}/${owner.repository}/raw/main/${content.path}" }
```

`zenwave-architecture`'s resolution specification anchors the workspace base at the
**manifest's own directory** and states that a transport or not-found failure
advances to the next candidate. That single rule is what makes both hosts work
without either being a special case:

| Situation | What resolves |
| --- | --- |
| Sibling repositories checked out | `workspace`, nothing remote |
| A repository not checked out | not found → `git` |
| Only one repository open, in a browser | `workspace` misses → `git` |

So **the web host needs no root folder**, and needs no remote-only mode either:
on the web the workspace source simply finds nothing. The desktop layout with
sibling checkouts is the optimisation, not the requirement.

Two earlier drafts of this design got this wrong in opposite directions. One had
the extension send `workspaceFolders` so the workspace source could map
repository names onto folders; the other had the web host force remote-only
resolution. Both were solving problems the manifest had already solved with its
expressions and its ordering, and both would have put a second opinion about
content location inside a VS Code extension. Removed.

The consequence here is a prohibition rather than a feature: the extension does
not resolve content, does not join paths on the manifest's behalf, does not
fetch, and does not choose a source.

### Pinning a source is a user's choice, not the extension's

What survives of source selection is a control, not a mechanism.
`ManifestLoadOptions` already carries `preferredSource` and `allowFallback`, and
the guide states that a preferred source may reorder or restrict the already
active ones but cannot inject one the manifest does not declare. Exposing that as
a setting gives a user the deliberate "show me the published versions" mode — the
same choice the EventCatalog generator offers — and gives the error the spec
requires when they pin a source this manifest does not have.

The plumbing is missing rather than the mechanism: the LSP constructs
`ZenWaveManifestLoader()` with defaults and `WorkspaceRuntime(loader).open(uri)`,
so nothing carries load options through today.

### The editor holds the credentials, and hands them over one request at a time

`AuthenticationValue(key, value, type, urlPatterns)` splits along exactly the
right seam: the patterns, the header name and the type are configuration, and
only `value` is a secret. So the configuration can live in settings and the
secret does not have to.

Where the secret comes from, in order: `vscode.authentication` for hosts the
editor already signs into — nothing is stored, the token refreshes itself, and in
github.dev the session already exists — and `SecretStorage` for everything else,
which is the OS keychain rather than a file.

Not workspace settings. `.vscode/settings.json` is committed with the project; a
token recorded there is a token shared with everyone who clones it. This is worth
stating because it is the obvious place to put it and the suggestion comes up
every time.

The server asks for a credential when it needs one, rather than being handed a
set at initialise. A token obtained at startup expires while the session is still
running, and a server holding long-lived secrets makes every crash log a
disclosure. Asking also puts the release decision on the side that knows what the
user authorised — which is what the matching requirement in the spec is for.

**That requirement is a security boundary, not a nicety.** A manifest is a file
in a repository, and opening a repository is not a decision to trust it. A
manifest declaring a source on an attacker's host would otherwise cause the
server to ask for a credential for that host, and the client to hand one over.
The credential goes only to locations the user authorised.

### Open documents outrank resolved content

An artefact can be two things at once: a file the user is editing, and an entry
the manifest resolves from somewhere. They must not disagree.

The case that makes it concrete is the browser. Opening the architecture
repository in github.dev, its own flows resolve through whatever remote source
the manifest declares, because there is no other repository present. A user
editing a flow would then watch the diagram keep showing the committed version —
the feature would look broken in precisely the setting it was built for.

So open document content wins, always, in both hosts. This is a server behaviour:
the server holds the open documents through `didOpen` / `didChange` and performs
the resolution, so it is the only place the overlay can happen. It is specified in
the `zenwave-specs` store, because every "the view tracks the document"
requirement in both IDE clients depends on it.

The extension's part is only to be a well-behaved language client — and not to
read model files itself, which would reintroduce the same disagreement from the
other side.

### Web LSP is specified, not promised

The spec says the web host uses a worker transport *when a worker server is
available in this build*, and otherwise reports `none` and falls back cleanly.
That is deliberately weaker than "web works", because `lsp-js` cannot currently
deliver it.

The alternative — writing the requirement as if web LSP worked — would make the
change unimplementable and the spec a lie. This way `004` and `005` can be
reviewed against a truthful statement of what the web host will do, which is:
show their empty state, with a reason.

## Risks / Trade-offs

- **Blocked on upstream, with no date.** This change can be reviewed and merged
  as a spec while `zenwave-lsp` catches up. The risk is that reviewing a spec
  against a server that does not exist misses things only a running server would
  reveal. Mitigated by expecting to revise the delta during implementation —
  the workflow allows a proposal to learn.
- **First real wire consumer.** Anything IntelliJ gets away with in-process —
  non-serialisable types, blocking calls, shared mutable state — will surface
  here as a protocol bug. Budget for upstream fixes, not just client work.
- **Two transports double the test surface**, and the browser one cannot be
  tested at all until `lsp-js` exists. Until then, `npm run run-in-browser` can
  only verify the fallback path, which is worth verifying anyway.
- **Manifest discovery reads the workspace, not a disk.** In the web host the
  folders are virtual; discovery goes through `vscode.workspace.fs` and may find
  nothing. The spec's "no workspace configuration at all" scenario is ordinary
  there, not an edge case.
- **Two workspace folders could each carry a configuration.** There is no obvious
  right answer, and picking the first silently is the wrong one. Left as an
  implementation decision with a task attached, on the condition that whatever is
  chosen is logged.
- **Credentials are a new trust boundary.** The `zenwave/credential` exchange is
  the first place where opening a repository can cause the extension to reach for
  a secret. The matching rule in the spec is what keeps that safe, and it is the
  requirement most worth a test rather than a careful reading.
- **A worker server cannot read the opened repository.** In the web host the
  JS defaults are `NodeFsLoader` and `FetchLoader`; the first is Node-only, and
  nothing but the extension host can read `vscode-vfs://`. Files the user has
  open arrive through `didOpen`, and everything else falls through to the remote
  source — so a file with uncommitted changes that the user has *not* opened
  resolves to its published version. Acceptable, and worth knowing before someone
  reports it as a bug.

## Decisions recorded during implementation

### Decision (task 1.2): `@zenwave360/lsp-js` is bundled into the VSIX, pinned by exact version, and is not an npm dependency

Decided by agent on 2026-09-17, pending review

**Chosen option:** the extension ships the server. The build copies the
package's two self-contained bundles — `exports["./node"]` and
`exports["./worker"]` — into `dist/server/node/zenwave-lsp-server.js` and
`dist/server/browser/zenwave-lsp-worker.js`, which `runtime-files.json` lists
and the VSIX carries. The version the extension is built and tested against is
pinned exactly, `0.1.0-SNAPSHOT` today, in `packages/extension/package.json`
under `zenwaveLanguageServer: { package, version }`. The build fails, naming
what to do, when the package is missing or is any other version.

- **Versioning.** One extension version ships exactly one server version. The
  server is not a separately updated component, so there is no compatibility
  range to maintain; capability discovery (`customRequests`) still guards the
  client against a contributor's `zenwave.lsp.serverPath` build being older or
  newer.
- **Not a runtime dependency.** Nothing `require`s the package at run time: the
  Node host forks a file, the web host starts a Worker from a URL. The VSIX is
  packaged `--no-dependencies`, so a runtime dependency would add nothing.
- **Why not `devDependencies` today.** The package is not on the npm registry, so
  declaring it would need a lockfile entry that resolves only on the machine that
  linked it — which `002` accepted for `@zenwave360/dsl` and which this change
  does not repeat. The local link is `ZENWAVE_LSP_JS_DIR` (the unpacked package)
  or `npm install --no-save` of the tarball; see the extension README.
- **When it is published:** move the pin to an exact-version `devDependencies`
  entry with a registry lockfile entry, have the build resolve it from
  `node_modules` only, and drop the `zenwaveLanguageServer` field. A clean
  checkout still fails until then, as it already does for `@zenwave360/dsl`
  (`002` task 1.2), and `008`'s pipeline stays red for the same reason.
- **Size.** Each bundle is ~6 MB uncompressed (elkjs included). Both are always
  shipped, because one VSIX serves both hosts.
- **Licences.** The bundles embed third-party code (vscode-languageserver, elkjs
  under EPL-2.0, Kotlin/JS runtime). Their notices are the package's to carry;
  today it ships none — raised for review, not decided here.

### Decision (task 4.4): when several workspace folders offer a manifest, the first folder in workspace order wins, and the rest are named

Decided by agent on 2026-09-17, pending review

A manifest setting in any folder outranks every `.zenwave/config.yml`; within
a route, the first folder in `workspace.workspaceFolders` order wins. Every
offer that was not used is written to the output channel next to the resolved
manifest (`note: … ignored, folder "a" comes first`), and the same setting
inherited by every folder is not reported as a conflict. Workspace order is
something the user can see and change, which a filesystem-derived rule is not.

### Decision: a changed resolution restarts the server; a changed file is notified

Decided by agent on 2026-09-17, pending review

When the manifest setting, a `.zenwave/config.yml` or the workspace folders
change, the client resolves again. If the server would be initialised with a
different `configUri` or `projectManifestUri`, the client restarts it with the
new initialization options — no protocol is invented for "the manifest moved",
and it works with today's server. If only the content of the configuration or
the manifest changed, the language client forwards the standard
`workspace/didChangeWatchedFiles`; open documents already reach the server
through `didChange`. The server ignores both notifications today (store
`001-ide-client-contracts` task 2.9), so a saved edit to a manifest that is not
open is not yet taken up without a restart.

### Decision: credential authorisation lives in user settings only

Decided by agent on 2026-09-17, pending review

`zenwave.credentials.origins` is `application`-scoped, so a repository cannot
authorise an origin for itself through `.vscode/settings.json`. Each entry is a
bare origin plus how the credential is applied; `source: github` takes the
token from `vscode.authentication` (silently, adding an Accounts-menu sign-in
request rather than a modal prompt when there is no session, and forcing a new
session when the server reports the token was rejected); `source: stored`
takes it from `SecretStorage`, recorded with **ZenWave: Record Credential**.
The default authorises the three GitHub origins for GitHub sign-in. A request is
matched on the origin of its own URL, which must also equal the origin the
server states. The handler follows store decision 1.4's wire shape and the
client advertises `clientCapabilities.credentialRequest: true`; no server sends
the request yet (store tasks 2.12/2.13).

### Implementation note: selecting the manifest by URI

The manifest's document filter is `{ scheme, pattern: <fsPath> }`. VS Code
scores a pattern equal to a document's `fsPath` as a match before treating it as
a glob, so exactly that file is selected whatever its name contains; a
`RelativePattern` object is not accepted by the language client's protocol-typed
selector. Evidence that the precision matters beyond noise: sending the
fixture `modules/…/openapi.yml` to `@zenwave360/lsp-js` 0.1.0-SNAPSHOT makes the
server stop answering every request (filed in the store, `001` task 2.17).
