# 007 — Model actions

## Why

Three things the IntelliJ plugin does, that the VS Code specs quietly left out.

They were missed for the same reason: `003-lsp-client` requires that
"server-backed language features come from the server", and that reads like it
covers everything the server can do. It does not. It covers what the server
**advertises through standard LSP** — diagnostics, completion, hover, definition,
formatting — which arrive through the language client with no code here.
ZenWave's own requests are different: nothing surfaces them unless this repo
builds a command and a place to put it.

The server already answers all three, and IntelliJ already uses all three:

- **`zenwave/forwardReferences` and `zenwave/reverseReferences`** — what a concept
  points at, and what points at it. Across documents and repositories, which is
  what makes them worth having over ordinary Find References.
- **`zenwave/conceptAt`** — which architectural concepts a position in a document
  belongs to. IntelliJ shows it through documentation and navigation.
- **`zenwave/organizeZflServices`** — rewrites a ZFL document's services into a
  canonical arrangement, and returns the new text.

The last one is a plain editing command with an action in IntelliJ's menu, and
it is the clearest instance of the gap: there is nothing subtle about it, it just
was not written down anywhere.

## What Changes

- **Go to what this connects to** — commands that take the concept under the
  cursor and show what it references, and what references it, with the results
  navigable.
- **What am I looking at** — the architectural concepts the current position
  belongs to, surfaced where the user already looks for context.
- **Organise ZFL services** — a command that rewrites the active flow's services
  into the server's canonical arrangement, as one undoable edit.
- All three **hidden when no server is connected**, rather than failing.

## Capabilities

### New Capabilities

- `model-actions`: commands that act on the model document in front of the user
  by asking the language server what it knows — following references across
  documents, reporting the concepts a position belongs to, and applying a
  server-produced rewrite.

### Modified Capabilities

None.

## Impact

- **Depends on `003-lsp-client`** for the request helper and the connected-server
  context key.
- **The four requests exist, but one path through them does not.** An earlier
  draft called this change free of new server work and free of new contracts.
  Both were wrong. The reference requests take a document symbol, and nothing on
  the wire turns a cursor position into one — the request that reports concepts at
  a position answers with architecture identities instead. A position-to-symbol
  step is now a contract in `zenwave-specs/001`, and until it lands the two
  reference commands cannot be built.
- **The requests themselves are cross-repo contracts**, contrary to that same
  draft. They bind this client to `zenwave-lsp` by the project's own test, and
  are recorded in the store alongside the rest.
- **Shares `006-model-explorer`'s vocabulary**: the tree navigates by
  `sourceUri` / `sourceRange` and offers `relatedResources`; these commands
  navigate the same way from the editor. Worth keeping the two consistent, and
  worth not duplicating the navigation helper.
- **`package.json`** — commands, editor context-menu entries and palette entries,
  all gated on a connected server.
- **First wire consumer of these four requests**, as with everything else: they
  have only ever been called in-process from IntelliJ.
