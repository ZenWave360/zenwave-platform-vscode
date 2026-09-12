# 007 — Design

## Context

All three requests exist in `lsp-jvm`'s `ZenwaveCustomRequests` and are
advertised in its initialize result:

```kotlin
@JsonRequest("zenwave/forwardReferences")  fun forwardReferences(SemanticReferenceRequest)
@JsonRequest("zenwave/reverseReferences")  fun reverseReferences(SemanticReferenceRequest)
@JsonRequest("zenwave/conceptAt")          fun conceptAt(ConceptAtRequest)
@JsonRequest("zenwave/organizeZflServices") fun organizeZflServices(OrganizeZflServicesRequest)
```

`SemanticReferenceRequest(uri, semanticId)` — note it takes a **semantic id**,
not a position, so something has to turn "where the cursor is" into a concept
first. `conceptAt` is the request that does that, and
`WorkspaceArchitecturePlane.conceptsAt(DocumentSymbolRef(uri, semanticPath))`
shows the shape the core works in.

`organizeZflServices` returns `String?` — the whole rewritten document, or
nothing.

IntelliJ's `ZflOrganizeServicesAction` is worth copying in one respect: it does
the work on a background thread, applies the result in a write action, and shows
an error dialog when the support layer returns null. The parts worth *not*
copying are its two availability checks — `isVisible` on the file extension and
`isEnabled` on the LSP being available — which VS Code expresses as `when`
clauses instead.

## Goals / Non-Goals

**Goals:**

- Parity for three features that are cheap, already answered by the server, and
  currently invisible in VS Code.
- Consistency with `006-model-explorer`: the same idea of navigating to a concept
  should behave the same from the tree and from the editor.

**Non-Goals:**

- **Replacing Go to Definition or Find References.** Those come through standard
  LSP when the server advertises them, and `003` already says so. These commands
  are the architectural relations, which are a different question — across
  documents and repositories, not within a file.
- **A references panel of our own.** VS Code has places to put a list of
  locations; inventing a view for this would be a worse version of one.
- **Organising anything other than ZFL services.** The server offers one rewrite;
  this exposes one rewrite.
- **Code actions.** Offering organise-services as a quick fix on a diagnostic is
  plausible and is not this change; it is a command first.

## Decisions

### These are commands, because nothing else surfaces them

`003`'s requirement — server-backed features come from the server — is true and
misleading. It describes features the language client wires automatically from
the server's advertised capabilities. A custom JSON-RPC request has no such
wiring: it is invisible until someone writes a command, a menu entry and a
`when` clause.

Recording that here because it is the mistake that caused this change to be
missing in the first place, and the same trap sits in front of every future
`zenwave/*` request.

### One capability, three features

Navigating references and rewriting a services block are not the same thing for a
user, and grouping them is a judgement rather than an obvious fit.

They are one capability because they would always be specified, reviewed and
broken together: all three are a ZenWave custom request turned into an editor
command, all three depend on the same request helper and the same
connected-server gating, and all three fail the same way when a server is too old.
Splitting them would produce three capabilities whose specs were mostly the same
paragraph about availability.

If the navigation half grows — a references view, relation filtering, a graph —
it earns its own capability then.

### Position to symbol is missing, and `conceptAt` is not it

`forwardReferences` and `reverseReferences` take `SemanticReferenceRequest(uri,
semanticId)`, where the id is a document symbol — `"$uri#$path"`. A cursor
position has to be turned into one of those first.

An earlier draft of this design said `conceptAt` was that step. It is not.
`conceptAt` answers with `ArchitectureConceptRef(id, kind, name,
identityOrigin)` — *architecture* identities, from the manifest's world, not
document symbols. Passing one to a reference request asks a question about the
wrong thing.

The server does have the step internally: its own `references` implementation
resolves a position through `hover(uri, position)?.documentSymbol` and composes
`"${uri}#${semanticPath}"`. But that is inside the server, not on the wire, and a
client reaching for hover's payload to extract an id would be depending on an
accident.

So a position-to-symbol step is an upstream prerequisite, now a contract in
`zenwave-specs/001`. Until it exists, the two reference commands cannot be
implemented from a cursor — which makes this change more blocked than an earlier
draft of its proposal claimed.

`conceptAt` keeps its own command, which asks a different and legitimate
question: which architectural concepts cover this position.

### Organise replaces the document, and must be one undo

The server returns the whole document. The tempting implementation is to replace
the entire text, and the reason to be careful is that a full-range replacement
collapses the user's cursor and folds, and stacks badly in undo history.

The spec asks for one undoable edit and for no modification when nothing changes.
Both are user-visible, and the second is what stops the command from dirtying a
file that did not need it.

A failure must leave the document untouched — which means applying the edit only
after a result arrives, never optimistically.

### Availability is a `when` clause, checked again on execution

Same rule as `002` and for the same reason: context keys hide, they do not
secure, and a command is invokable from the palette and programmatically. `003`
publishes the connected-server key; the "supported by this server" distinction
comes from its advertised request list.

## Risks / Trade-offs

- **Three requests that have never crossed a wire.** `SemanticReferenceRequest`
  and the navigation targets it returns are the third set of DTOs in this
  programme to be exercised for the first time by VS Code. Expect the same class
  of serialisation problem the other changes budget for.
- **`conceptAt` may be ambiguous.** A position can belong to several concepts,
  and the core returns a list with a `truncated` flag. Presenting that well is
  not obviously a list — but this change should not invent a presentation before
  seeing real results.
- **Organise is a whole-document rewrite from a remote process.** It is the only
  feature in the whole programme where the server changes the user's file. Worth
  treating with more suspicion than the read-only ones, which is why "left
  untouched on failure" and "not modified when unchanged" are requirements rather
  than implementation notes.
- **Overlap with the tree.** `006` navigates by `sourceUri` / `sourceRange` and
  offers `relatedResources`; these commands navigate from the editor. If the two
  drift in how they present a target, users will notice before we do.
