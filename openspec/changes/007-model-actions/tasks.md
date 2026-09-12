# 007 — Tasks

## 1. Prerequisites

- [ ] 1.1 `003-lsp-client` implemented — the request helper and the
      connected-server context key
- [ ] 1.2 **Upstream:** a position-to-symbol step on the wire, since
      `conceptAt` returns architecture identities and the reference requests take
      document symbols — the two reference commands are blocked on it
- [ ] 1.3 Confirm the four requests behave over a wire as they do in-process:
      `forwardReferences`, `reverseReferences`, `conceptAt`,
      `organizeZflServices`

## 2. Concept resolution

- [ ] 2.1 Resolve the cursor position to a document symbol through whatever
      upstream provides — **not** `conceptAt`, which answers about architecture
- [ ] 2.2 No concept at the position resolves to nothing, quietly
- [ ] 2.3 Handle several concepts at one position, and the core's `truncated`
      flag, without inventing a presentation before seeing real results

## 3. Navigation commands

- [ ] 3.1 `zenwave.model.forwardReferences` and
      `zenwave.model.reverseReferences`, from the editor context menu and the
      palette
- [ ] 3.2 Present results as locations the editor can navigate, reusing whatever
      `006` uses to open a target so the two stay consistent
- [ ] 3.3 A single result navigates directly rather than offering a list of one
- [ ] 3.4 No results says so
- [ ] 3.5 Targets in other documents open correctly, including ones in other
      repositories of the workspace

## 4. Concepts at a position

- [ ] 4.1 `zenwave.model.conceptsAt` command
- [ ] 4.2 Report the concepts covering the position, named as the server names
      them
- [ ] 4.3 No architecture resolved says so, and points at the manifest setting

## 5. Organise ZFL services

- [ ] 5.1 `zenwave.zfl.organizeServices` command, offered for `.zfl` only
- [ ] 5.2 Request off the UI thread; apply the result as one workspace edit
- [ ] 5.3 Apply nothing when the request fails, and report why
- [ ] 5.4 Apply nothing when the result equals the current text — do not dirty
      the file or disturb undo
- [ ] 5.5 Confirm a single undo restores the document exactly
- [ ] 5.6 Check what happens to cursor and folding after the rewrite; a
      whole-document replacement collapses both

## 6. Availability

- [ ] 6.1 `when` clauses on a connected server and, per command, on the server
      advertising that request
- [ ] 6.2 Re-check on execution — a command is invokable from the palette and
      programmatically
- [ ] 6.3 Each command reports the distinction between no server and a server
      that does not support it

## 7. Verification

- [ ] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] 7.2 Forward and reverse references on the fixtures, including a target in
      another document
- [ ] 7.3 Concepts at a position inside a service declaration
- [ ] 7.4 Organise the `place-order-flow.zfl` fixture; undo it in one step
- [ ] 7.5 Organise a fixture with a syntax error: unchanged, explained
- [ ] 7.6 Organise an already-organised fixture: not dirtied
- [ ] 7.7 With the server stopped: none of the commands are offered
- [ ] 7.8 Compare all three against IntelliJ on the same fixtures
- [ ] 7.9 `openspec validate 007-model-actions --strict`

## 8. Archive

- [ ] 8.1 `openspec archive 007-model-actions`
