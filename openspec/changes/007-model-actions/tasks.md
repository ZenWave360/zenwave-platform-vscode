# 007 — Tasks

## 1. Prerequisites

- [x] 1.1 `003-lsp-client` implemented — the request helper and the
      connected-server context key
      Available on the base branch vscode-platform/client-003 (42a10db): `LanguageServerApi.requests`
      (four-way `RequestResult`), `zenwave.languageServerAvailable` and `zenwave.languageServerRequests`.
- [x] 1.2 **Upstream:** a position-to-symbol step on the wire, since
      `conceptAt` returns architecture identities and the reference requests take
      document symbols — the two reference commands are blocked on it
      Available: `zenwave/symbolAt` in @zenwave360/lsp-js 0.1.0-SNAPSHOT (zenwave-lsp d7156e7, store 001
      2.7). Smoke test (both hosts): symbolAt on `when CheckoutStarted do createOrder` -> `#flows.CheckoutFlow.commands.createOrder`,
      accepted by forwardReferences; a blank line -> null.
- [ ] 1.3 Confirm the four requests behave over a wire as they do in-process:
      `forwardReferences`, `reverseReferences`, `conceptAt`,
      `organizeZflServices`
      Open: `conceptAt` does not exist on the wire (store 001 2.18), so only three of the four can be confirmed.
      Confirmed over a wire: `forwardReferences`, `reverseReferences`, `organizeZflServices` - upstream lsp-jvm
      ZenwaveLspWireTest, lsp-js nodeIpcTest and WorkerWireTest (store 001 2.15), plus this branch's smoke test
      against the real server over IPC (desktop) and in a Web Worker (browser). Gaps against what the commands
      need are filed as server tasks: reverseReferences always `[]` for ZFL uses (001 2.19), targets carry no
      `range` (001 2.20), symbolAt null on a ZDL entity name (001 2.21). organizeZflServices answers `null`
      (not an error) for a flow it cannot parse.

## 2. Concept resolution

- [x] 2.1 Resolve the cursor position to a document symbol through whatever
      upstream provides — **not** `conceptAt`, which answers about architecture
      vscode-platform/client-007: `src/model/actions.ts` `followReferences` -> `requests.symbolAt(uri, position)` (the cursor, or
      `(uri, {line, character})` arguments), then passes `{uri, semanticId}` on unchanged.
- [x] 2.2 No concept at the position resolves to nothing, quietly
      symbolAt `null` -> outcome `no-symbol`, logged at debug only, no message, no navigation (smoke, both hosts).
- [ ] 2.3 Handle several concepts at one position, and the core's `truncated`
      flag, without inventing a presentation before seeing real results
      Open, blocked on zenwave-lsp 001 2.18: symbolAt answers one symbol or null; the list with a
      `truncated` flag belongs to the concepts-at-a-position request, which does not exist.

## 3. Navigation commands

- [x] 3.1 `zenwave.model.forwardReferences` and
      `zenwave.model.reverseReferences`, from the editor context menu and the
      palette
      vscode-platform/client-007: commands contributed and registered; palette and `editor/context` (group `navigation`) entries
      (`package.json`; asserted by `test/unit/model-actions.test.ts`).
- [x] 3.2 Present results as locations the editor can navigate, reusing whatever
      `006` uses to open a target so the two stay consistent
      Locations use the editor's own presentation: `src/model/navigation.ts` (`toLocation`, `openLocation`,
      `presentLocations` -> `editor.action.goToLocations` peek for several). This is the shared helper `006`
      should use for `sourceUri`/`sourceRange` and related resources. A target without a range opens at the
      document start (every target today, store 001 2.20).
- [x] 3.3 A single result navigates directly rather than offering a list of one
      One target -> `openLocation` directly; smoke (both hosts) asserts outcome `navigated` and that the active
      editor becomes `lsp/orders/model.zdl`.
- [x] 3.4 No results says so
      No targets -> information message "The ZenWave language server reports nothing that references the
      symbol at line N." and outcome `none`, no navigation (smoke, both hosts, reverseReferences).
- [ ] 3.5 Targets in other documents open correctly, including ones in other
      repositories of the workspace
      Other documents: done (forward from `lsp/checkout.zfl` opens `lsp/orders/model.zdl` in both hosts,
      including `vscode-test-web:` URIs). Other repositories of a workspace: open - needs a multi-repository
      workspace whose server answers targets there (store 001 2.11/2.14), then a human check.

## 4. Concepts at a position

- [ ] 4.1 `zenwave.model.conceptsAt` command
      Open, blocked on zenwave-lsp conceptAt (store 001 2.18). The command is deliberately not contributed
      until a server advertises the request (a unit test asserts it is absent).
- [ ] 4.2 Report the concepts covering the position, named as the server names
      them
      Open, blocked on zenwave-lsp conceptAt (store 001 2.18). The command is deliberately not contributed
      until a server advertises the request (a unit test asserts it is absent).
- [ ] 4.3 No architecture resolved says so, and points at the manifest setting
      Open, blocked on zenwave-lsp conceptAt (store 001 2.18). The command is deliberately not contributed
      until a server advertises the request (a unit test asserts it is absent).

## 5. Organise ZFL services

- [x] 5.1 `zenwave.zfl.organizeServices` command, offered for `.zfl` only
      vscode-platform/client-007: `zenwave.zfl.organizeServices`, `when` `editorLangId == zfl && ...`; invoked on a ZDL it reports
      "works on a ZFL document" and changes nothing (smoke, both hosts).
- [x] 5.2 Request off the UI thread; apply the result as one workspace edit
      The request runs in the server (child process / worker) under `withProgress`; the answer is applied as one
      `WorkspaceEdit` replacing only the span between common prefix and suffix (`src/model/text-replacement.ts`,
      line endings brought to the document's EOL). Nothing is applied if the document changed meanwhile.
- [x] 5.3 Apply nothing when the request fails, and report why
      Request failure -> message with the reason, nothing applied; `null` (server could not process it) ->
      warning naming the error count in Problems with a "Show Problems" action; smoke (both hosts) asserts the
      broken flow keeps its text and version.
- [x] 5.4 Apply nothing when the result equals the current text — do not dirty
      the file or disturb undo
      Equal text -> no edit, outcome `unchanged`, a status-bar note only; smoke asserts the version is unchanged
      (both hosts) and an organised copy on disk is not dirtied (desktop).
- [x] 5.5 Confirm a single undo restores the document exactly
      Smoke: one `undo` restores the text exactly (untitled copy of `lsp/checkout.zfl` in both hosts;
      `place-order-flow.zfl` on the desktop, which is also clean again).
- [ ] 5.6 Check what happens to cursor and folding after the rewrite; a
      whole-document replacement collapses both
      Cursor: the minimal replacement leaves a cursor after the change where it was (smoke asserts 27:8 is
      kept, both hosts). Folding: needs a human (fold a region below the systems block, organise, check it stays
      folded).

## 6. Availability

- [x] 6.1 `when` clauses on a connected server and, per command, on the server
      advertising that request
      vscode-platform/client-007: `zenwave.languageServerAvailable && 'zenwave/symbolAt' in zenwave.languageServerRequests && 'zenwave/<request>' in ...`
      per command, in the palette and the editor context menu; a unit test checks every entry.
- [x] 6.2 Re-check on execution — a command is invokable from the palette and
      programmatically
      `commandAvailability` runs before every execution; smoke (desktop) turns `zenwave.lsp.enabled` off and
      invokes both kinds of command programmatically: outcome `no-server`, document unchanged.
- [x] 6.3 Each command reports the distinction between no server and a server
      that does not support it
      Messages distinguish "needs the ZenWave language server, which is not available here: <reason>" (or
      "still starting") from "is not supported by the connected ZenWave language server (<version>): it does not
      offer <request>" (`test/unit/model-actions.test.ts`; smoke for no-server).

## 7. Verification

- [x] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
      vscode-platform/client-007: typecheck, lint, 82/82 unit tests, build.
- [ ] 7.2 Forward and reverse references on the fixtures, including a target in
      another document
      Forward: done in both hosts (a target in another document). Reverse: runs and reports none, because the
      server finds no reverse references (store 001 2.19); re-verify when that lands.
- [ ] 7.3 Concepts at a position inside a service declaration
      Open, blocked on zenwave-lsp conceptAt (store 001 2.18).
- [x] 7.4 Organise the `place-order-flow.zfl` fixture; undo it in one step
      Desktop smoke on the copied `place-order-flow.zfl`: organised, one undo restores it exactly and clean.
      Browser: an untitled copy of `lsp/checkout.zfl` (test-web serves the real fixtures folder).
- [x] 7.5 Organise a fixture with a syntax error: unchanged, explained
      Smoke (both hosts): `flow Broken { when {{ do` -> outcome `not-organizable`, the message says why and that
      the document was left unchanged; text and version unchanged.
- [x] 7.6 Organise an already-organised fixture: not dirtied
      Smoke: organising twice -> the second is `unchanged` with the version untouched (both hosts); an organised
      copy on disk stays not dirty (desktop).
- [ ] 7.7 With the server stopped: none of the commands are offered
      Automated: `when` clauses require `zenwave.languageServerAvailable` (unit test), which 003 sets false
      unless connected; invoked with the server off, the commands refuse (smoke, desktop). Needs a human to look
      at the palette and editor context menu with `zenwave.lsp.enabled` off.
- [ ] 7.8 Compare all three against IntelliJ on the same fixtures
      Needs a human (IntelliJ).
- [x] 7.9 `openspec validate 007-model-actions --strict`
      `openspec validate --all --strict`: pass.

## 8. Archive

- [ ] 8.1 `openspec archive 007-model-actions`
