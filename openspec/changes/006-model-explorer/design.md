# 006 — Design

## Context

The data for both trees already exists and is already reachable. That is the
finding that shaped this change, and it is worth writing down because the
opposite was assumed twice during design.

`ZenwaveLanguageServer.hierarchy(uri)` dispatches **by URI** to whichever
`LanguageModule` claims the document. The modules present in `lsp-core` include
`zdl`, `zfl`, `manifest`, and a few spec formats, and
`ArchitectureManifestLanguageModule` declares:

```kotlin
override val languageId: String = "manifest"
extensions = listOf(".yml", ".yaml", ".json")
supportsHierarchy = true
```

So the architecture tree is not a new request. It is `zenwave/hierarchy` pointed
at the manifest, whose location `zenwave/workspaceStatus` already reports as
`manifestUri`. Two trees, one request, two ways of deciding which URI to ask
about.

**It is new server behaviour, though.** `withEntry` returns `null` when
`sessionStore.get(uri)` finds nothing, and `openWorkspace(manifestUri)` builds the
architecture plane without opening the manifest as a document — so asking for the
hierarchy of a manifest nobody opened returns an empty list, which is the
architecture tree's whole reason to exist. The client must not paper over that by
quietly opening the manifest itself: `003` forbids it from reading model content
on the manifest's behalf, and it would put editor state into the session for a
document the user never asked to edit. The fix is upstream and is now a contract.

That the module claims `.yml` / `.yaml` / `.json` is broad enough to be alarming,
but it never becomes a problem here, because the tree never asks the server to
find a manifest. `003` resolves exactly one per workspace — from a setting, or
from a workspace folder's `.zenwave/config.yml` — and this tree asks about that
URI and no other.

The node shape maps onto a VS Code tree almost without translation:

```kotlin
data class HierarchyNodeDto(
    val id: String, val label: String, val kind: String, val language: String,
    val sourceUri: String, val sourceRange: Range,
    val children: List<HierarchyNodeDto>,
    val relatedResources: List<NavigationTarget>,
    val uiHints: Map<String, String>
)
```

`children` is the tree, `sourceUri` + `sourceRange` is the navigation, `kind` and
`uiHints` drive presentation, `relatedResources` is a context menu, and `id` is
the handle the diagram highlights by.

`sourceUri` is **per node** rather than per request, which *permits* a hierarchy
that spans documents. An earlier draft of this design called that "structural
proof" that it does. It is neither proof nor true today: `ZflHierarchyBuilder`
resolves every node's source against the requested URI, and the annotated ZDL is
exposed only as a related resource. The cross-document hierarchy is a contract in
`zenwave-specs/001` and a plan upstream — `spec/02-zfl-hierarchy-enrichment.md`,
whose first line reads *Implementation Plan* — not behaviour to build against.

That misreading is worth naming, because it produced three of this change's
scenarios: reading a planning document as a description of what exists.

## Goals / Non-Goals

**Goals:**

- The hierarchy IntelliJ shows, with navigation that goes where the node lives.
- An architecture view that is useful before any file is open.
- One provider behind both trees.

**Non-Goals:**

- **Replacing the standard Outline.** It answers a different question and should
  also exist; see the decision below.
- **Implementing `textDocument/documentSymbol`.** That is the server's, and it
  arrives through the language client with no code here.
- **Editing the model from the tree.** Renames, moves and refactors are a
  different capability with a different contract.
- **A tree for every language the server supports.** `lsp-core` also has modules
  for Avro, AsyncAPI and OpenAPI. The provider will not prevent them, but
  specifying them is not this change.
- **Diagram → tree selection.** The bundle has no outbound selection message, as
  `004` records. When it grows one, the wiring belongs here.

## Decisions

### Two trees, one provider

`TreeDataProvider` is parameterised by how it resolves its root:

```
Architecture  →  the manifest `003` resolved, as reported by
                 zenwave/workspaceStatus().manifestUri
Model         →  the model document the user is looking at
```

Taking it from `workspaceStatus` rather than re-reading the setting keeps one
source of truth at runtime: the tree shows the architecture the *server* is
actually working against, so a tree that looks wrong is evidence about the
server's state rather than a second opinion about it.

Everything after that — mapping nodes to items, icons, navigation, context menus,
refresh — is shared. The two views differ in root resolution and in what makes
them refresh, and in nothing else.

This is why the architecture tree did not earn its own change even though it is
independently useful: the marginal cost is one view and one root strategy.

### Following the user without losing the user's place

The obvious rule — the tree shows whatever model document is focused — breaks the
tree the first time somebody uses it. A flow's tree contains systems declared in
the ZDL files it annotates; selecting one opens that ZDL; the ZDL is now focused;
the tree retargets; the flow the user was exploring is gone. Using the navigator
throws away what you were navigating.

The fix is not to suppress the retarget after a click, which would need the tree
to remember it caused the navigation and would still be wrong when the user
arrives the same way by other means. It is to say what a change of context
actually is:

> the tree retargets when the focused model document is **not already part of the
> hierarchy it is showing**.

The ZDL the flow annotates is in the tree — its nodes carry its `sourceUri` — so
arriving there is drilling in, and the tree holds. A model document the tree
knows nothing about is somewhere else, and the tree follows.

This costs one case: opening, from the explorer, a ZDL that happens to belong to
the current flow, wanting its own hierarchy. It will not retarget. That is rarer
than the broken case, and a "show this document's hierarchy" command covers it if
it turns out to matter. An explicit pin in the view title is the escalation if
this rule proves too clever in use — it makes the state visible at the cost of
leaving the default behaviour wrong.

### The active document comes from tab groups, not the active text editor

`window.activeTextEditor` is `undefined` whenever a custom editor has focus, and
with `004` and `005` the user is often in one. A model tree that empties whenever
the user looks at their own diagram would be useless precisely when it is wanted.

`window.tabGroups.activeTabGroup.activeTab.input` answers regardless:
`TabInputText` and `TabInputCustom` both carry `.uri`. The tree filters on the
URI being a model document and ignores everything else, which also gives the
"keep showing the last model" behaviour for free — a non-model tab simply does
not produce a new root.

### This overlaps the Outline more than an earlier draft admitted

That draft argued the Outline could not express this hierarchy, because
`documentSymbol` returns ranges within one document. The server settles it the
other way:

```kotlin
override fun documentSymbol(params) =
    server.hierarchy(params.textDocument.uri).map { …toDocumentSymbol(it) }
```

`documentSymbol` **is** the hierarchy. So the moment `003` connects a client, the
Outline shows the same conceptual tree for an open document — derived commands
included — with breadcrumbs, Go to Symbol and sticky scroll on top, and no code
here.

What survives as justification for a tree of our own is narrower and still
enough: an architecture browsable with no document open, a selection that
highlights in a diagram, related resources on a node, and nodes that point into
other documents once upstream emits them. None of that fits `DocumentSymbol`.

What does not survive is treating the overlap as a naming problem. Two trees
showing the same thing for one open ZFL is a real cost, and the honest mitigation
is to keep the Model tree earning its place: if everything it does for a single
open document also appears in the Outline, it should shrink to the architecture
view and the diagram wiring rather than compete.

It is still called **Model** rather than Outline, because it is not one — but the
name is no longer doing the argument's work.

### The client renders; the server describes

The server supplies `kind` and `uiHints` and deliberately does not format display
strings — its own plan says the IDE decides how to render labels, icons and
aggregates.

This is the **opposite** of the rule in `004` and `005`, where the server names
representations and the extension must not. Both are right, because they are
different data: a view model is a picture that must look the same in both IDEs,
and a hierarchy node is raw material each IDE presents in its own idiom.

An unknown `kind` must still render, with the label and a neutral icon. A client
that drops nodes it does not recognise turns a server upgrade into missing data,
and missing data in a tree is invisible — the worst kind of bug.

### Empty states are `viewsWelcome`, not fake nodes

A tree whose root is "⚠ No language server" is a tree that then has to defend
against that node being selected, expanded, or navigated from.
`contributes.viewsWelcome` is the native mechanism, renders as text with
actionable links, and keys off context keys — which `003` already publishes for
server availability.

### Selection into the diagram, one way for now

Tree selection posts `highlightNode` to the diagram editor for the same document,
if one is open. `TreeView.onDidChangeSelection` on one side, the message contract
from `004` on the other.

**Not with the hierarchy node's `id`**, which an earlier draft assumed and which
would highlight nothing. The two are identified differently — a hierarchy node by
`uri#semantic.path`, a view-model node by a kind-scoped name such as
`command:renewSubscription` — and nothing relates them. IntelliJ has no mapping
to copy, because it never wired tree selection to the diagram at all. A
correspondence a client can rely on is now a contract in `zenwave-specs/001`, and
until it exists this requirement is not implementable.

The reverse direction — clicking a diagram node to reveal it in the tree — needs
an outbound webview message that does not exist yet. `TreeView.reveal()` and
`TreeDataProvider.getParent` are what will implement it, so both are worth having
from the start; the cursor-follows-tree scenario in the spec exercises them
anyway.

### Decision (task 1.6): the Model tree keeps its scope

Decided by agent on 2026-09-17, pending review.

With `003` connected, the Outline does show a conceptual hierarchy for an open
document. It is not the same hierarchy the Model tree shows, as of zenwave-lsp
d7156e7:

- `textDocument/documentSymbol` stays within the document. A flow's `Orders`
  system and the services and commands its `@zdl` model declares point at the
  flow in the Outline and at the ZDL in the Model tree (store 001 2.5), which is
  what makes "go to the declaration" and the drill-in rule possible.
- The Outline has no related resources, and nothing it could be asked to
  highlight in a diagram.
- The Outline follows the active *text* editor; the Model tree keeps its document
  while a webview, a preview or a diagram has focus.

So the condition this design set for shrinking — everything the Model tree does
for one open document also appears in the Outline — does not hold, and the tree
stays. Revisit if `documentSymbol` gains cross-document locations, or if `004`
ships without the selection wiring.

### Implementation notes (vscode-platform/client-006)

- **Where the manifest comes from.** `zenwave/workspaceStatus` does not exist.
  The tree uses `LanguageServerApi.manifest.manifestUri`, the manifest `003`
  resolved and started the server with. It is still one source of truth — a
  different manifest restarts the server — but it is the client's resolution,
  not the server's report. The server-side report is store 001 task 2.22.
- **A browser-hosted server cannot read the manifest.** It answers
  `documentNotFound` for an unopened `vscode-vfs:` manifest. The tree shows that
  state once, explained, with an *Open Architecture Manifest* action; it does not
  retry and does not open the manifest itself. Once the user opens it, the server
  answers from the editor and the tree populates.
- **Empty states are per-tree context keys.** `zenwave.architectureTreeState` and
  `zenwave.modelTreeState` hold the reason (`no-server`, `unsupported`,
  `no-manifest`, `no-model`, `not-found`, `unreadable`, `empty`, `failed`,
  `loading`, `ready`). `003`'s boolean keys cannot tell these apart.
- **A document with syntax errors.** lsp-js d7156e7 answers a partial hierarchy
  for a flow with syntax errors, not `documentUnreadable`. The tree shows what it
  got and says in the view message that the document has errors. `unreadable`
  is still handled for a server that reports it.
- **The seam for `004`.** `DiagramPanels` (`src/explorer/diagram-selection.ts`)
  is a registry of open diagram panels by document URI, each with
  `highlightNode(viewNodeId | null)`. Tree selection sends the node's first
  `viewNodeIds` entry, or `null` for a node without one, to every panel open for
  the tree's document. A diagram editor registers a panel and disposes the
  registration when it closes.

## Risks / Trade-offs

- **Two trees where users expect one place to look.** The Outline, the Model tree
  and breadcrumbs will all show overlapping things. Naming and documentation
  carry the distinction, which is a weaker mechanism than design. Watch for
  confusion before adding a third.
- **First wire consumer of `zenwave/hierarchy`.** IntelliJ calls it in-process.
  A recursive DTO with nested ranges and a free-form `uiHints` map is exactly
  the shape that serialises badly without anyone noticing. Budget upstream fixes.
- **Refresh cost on a large model.** The tree refreshes on document change like
  everything else here; a deep hierarchy rebuilt on every keystroke is worth
  coalescing the same way the diagram is.
- **`zenwave/hierarchy` is a cross-repo contract that is not written down.** It
  predates the `zenwave-specs` store and is consumed by both IDEs. This change
  adds a requirement for it there rather than leaving the second consumer to
  discover the shape by reading Kotlin.
