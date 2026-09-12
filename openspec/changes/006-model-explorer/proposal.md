# 006 — Model explorer

## Why

IntelliJ's ZFL tool window is two things side by side: a diagram, and a
*Conceptual Hierarchy* tree next to it. `004` brings the diagram. This brings the
tree — and a second one that IntelliJ does not have yet.

The tree is not an outline, and that distinction is the whole reason this is a
capability rather than a line of configuration. Open `place-order-flow.zfl` in
IntelliJ and its tree shows `systems → OrdersCheckout → OrdersCheckoutService →
startOrderCheckout` — but `OrdersCheckout` is declared in
`orders-checkout-api/domain-model.zdl`, reached through an `@zdl(…)` annotation,
and `startOrderCheckout` is not declared under the service at all: the server
derives it by cross-referencing `when` blocks across every flow in the file.
`zenwave-lsp`'s own plan is explicit about it:

> Derives `service → command` by cross-referencing `when` blocks. Attaches ZDL
> file links from `@zdl` annotations.

An earlier draft of this proposal argued that the standard Outline could not
express any of that, because `textDocument/documentSymbol` returns a tree of
ranges within one document. **That argument is wrong.** This server implements
`documentSymbol` by delegating to the very same hierarchy, so once a language
client is connected the Outline shows the conceptual tree with no code here —
derived commands included.

What the Outline still cannot do is the rest of this change: an architecture
browsable with no document open, a selection that reaches a diagram, related
resources on a node, and nodes that point at a declaration in another document.
Those are the justification. "Outline cannot show derived commands" is not, and
the overlap for a single open document is a real cost rather than a naming
problem.

The second tree exists because a model is not the only thing worth navigating. A
workspace has an architecture manifest — domains, subdomains, repositories, docs
— and today the only way to explore it is to read the YAML. It is also the one
view that is useful before any file is open.

## What Changes

- A **ZenWave container in the activity bar**, with its own icon, holding two
  tree views.
- **Architecture** — the workspace's architecture manifest as a tree, available
  whether or not a model file is open.
- **Model** — the conceptual hierarchy of the model document the user is looking
  at, following them across the text, the preview and the diagram.
- **Navigation**: selecting a node opens what it stands for, and nodes that point
  at other resources offer them.
- **Selection shared with an open diagram**, so picking a node in the tree
  highlights it in the EventFlow editor.
- **Explained empty states** through `viewsWelcome`, rather than blank trees.

## Capabilities

### New Capabilities

- `model-explorer`: browsing the workspace's architecture and the conceptual
  hierarchy of a model document as trees, navigating from them to the source they
  describe, and sharing a selection with an open diagram.

### Modified Capabilities

None.

## Impact

- **Depends on `003-lsp-client`.** Both trees are server-fed; neither has a
  second source.
- **Needs no new server *request*, but does need new server behaviour.** An
  earlier draft claimed this change was unblocked beyond `003`. It is not, and an
  adversarial review of these specs is what established that:
  - `hierarchy(uri)` answers only for documents already in the server's session
    store, so asking about a manifest nobody has opened returns nothing — which
    is precisely the architecture tree's headline scenario;
  - every hierarchy node is built with the **requested** document's URI, and an
    annotated ZDL appears only as a related resource, so nodes pointing at a
    declaration in another document do not exist yet;
  - a hierarchy node and an EventFlow node are identified differently, so a tree
    selection cannot be matched to a diagram node.

  All three are now contracts in `zenwave-specs/001`. The manifest tree is still
  the *same* request pointed at a different URI — `hierarchy(uri)` does dispatch
  by URI, and `ArchitectureManifestLanguageModule` does declare
  `supportsHierarchy` — so one provider with two root strategies survives. What
  does not survive is the claim that it works today.
- **Interoperates with `004-eventflow-panel`** for selection highlighting. Each
  is useful without the other; only the sync scenarios need both.
- **Does not touch the standard Outline.** That comes from the server
  implementing `textDocument/documentSymbol`, arrives through the language client
  in `003` with no code here, and is worth having in addition — breadcrumbs, Go
  to Symbol and sticky scroll all come with it.
- **`package.json`** — a view container, two views, `viewsWelcome` entries, and
  `view/title` commands.
- **First wire consumer of `zenwave/hierarchy`.** IntelliJ calls it in-process;
  expect serialisation problems that the in-process route has been hiding.
