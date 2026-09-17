# 004 — Tasks

## 1. Upstream prerequisites

- [x] 1.1 `003-lsp-client` implemented — the view model has no other source
      Available on the base branch vscode-platform/client-006 (6e94e1d, stacked on client-007 and client-003):
      `LanguageServerApi.requests.eventFlowViews(uri)`, `status`, `onDidChange`, `documentFailure`.
- [x] 1.2 `zenwave-lsp`: a request returning the flow and service view models for
      a ZFL document (contract in `zenwave-specs`)
      Available: `zenwave/eventFlowViews` in @zenwave360/lsp-js 0.1.0-SNAPSHOT (zenwave-lsp d7156e7, store 001 2.1), linked
      with `ZENWAVE_LSP_JS_DIR`. Smoke, both hosts: the diagram renders the server's answer for `place-order-flow.zfl`
      and `lsp/checkout.zfl`.
- [x] 1.3 `zenwave-architectural-vistas`: the EventFlow webview bundle reaches
      this repo — a second sync target, or published as an npm package
      True locally: `@zenwave360/vistas-eventflow-webview` 0.1.0 (zenwave-architectural-vistas 2e60d25) reaches this repo
      through `ZENWAVE_VISTAS_WEBVIEW_DIR`; the build copies its `webview/` page into `dist/eventflow-webview`
      (`esbuild.mjs`). Publication is still open upstream (store 001 5.4).
- [x] 1.4 `zenwave-architectural-vistas`: the page posts `webviewReady` through
      the VS Code webview API when present, falling back to `window.parent`
      Available (vistas 2e60d25, store 001 5.1): the page posts `webviewReady` through `window.__zenwaveVsCodeApi`, which
      the editor's host script sets. Smoke, both hosts: `webviewReady` arrives with
      `{"protocol":"zenwave.eventflow.webview","protocolVersion":1}`.
- [ ] 1.5 Agree how the bundle version is pinned, so a protocol change cannot
      break the diagram silently
      Proposal implemented, pending review: design.md §Decision (task 1.5), decided by agent on 2026-09-17. The exact
      version and protocol version are pinned in package.json `zenwaveEventFlowWebview`, checked at build time against
      `webview/protocol.json` and at run time against `webviewReady`.

## 2. Diagram editor

- [x] 2.1 Register a custom editor for `.zfl` with `priority: "option"` — verify
      that opening a flow file still gives the text editor
      `contributes.customEditors` `zenwave.eventflow`, `*.zfl`, `priority: "option"` (unit test). Smoke, both hosts:
      `vscode.open` on `place-order-flow.zfl` gives a `TabInputText` and no diagram.
- [x] 2.2 Open it in the adjacent column for the beside gesture, focus staying in
      the text editor
      `zenwave.eventflow.openToSide` runs `vscode.openWith` with `ViewColumn.Beside` and `preserveFocus`. Smoke, both
      hosts: the diagram tab is in column 2 and the active tab is still the text.
- [x] 2.3 Open it in the current column for the in-place gesture, so the tab
      keeps its position
      `zenwave.eventflow.open` opens in the text tab's group, closes the text tab and moves the diagram to its index
      (`replaceInPlace`, src/eventflow/feature.ts). Smoke, both hosts: `checkout.zfl`'s diagram takes the text tab's
      index and the text tab is gone. A text tab with unsaved changes is kept open beside it.
- [x] 2.4 Name the document in the editor's tab
      Smoke, both hosts: the diagram tab's label is `place-order-flow.zfl`.
- [ ] 2.5 Confirm VS Code restores the diagram on window reload
      Open: needs a human (a window reload ends the test run). By construction a registered custom editor is restored
      by VS Code, and the editor rebuilds everything from the document URI.
- [x] 2.6 Never move or re-position an editor after opening it
      The editor never reveals, re-opens or moves its panel after `resolveCustomEditor`. Desktop smoke: after typing
      and re-rendering, the diagram is still alone in column 2 and the text keeps focus.
- [x] 2.7 Serve the bundle directory as a local resource root; rewrite the built
      page's asset references to webview URIs
      `localResourceRoots: [dist/eventflow-webview]`; `buildPageHtml` rewrites `./assets/…` to `asWebviewUri` and
      refuses any other reference (unit test). Smoke, both hosts: all 47 flow nodes render and the stylesheet loads.
- [x] 2.8 A content security policy that allows the bundle and nothing remote
      `default-src 'none'`, scripts and styles only from `webview.cspSource` plus one nonce, no `connect-src` (unit
      test). Smoke, both hosts: the page reports no `securitypolicyviolation`. Negative control: removing `cspSource`
      from `style-src` made the desktop smoke fail with the named load failure for the CSS.
- [ ] 2.9 Retain webview state while the editor is hidden; measure the cost with
      several diagrams open
      Retaining is implemented (`retainContextWhenHidden: true`). Open: measuring the memory cost with several
      diagrams open needs a human (Help > Open Process Explorer).
- [x] 2.10 Treat `webviewReady` as the signal that the page loaded; report a load
      failure as an error state rather than a blank editor
      `readiness` and `DiagramSession` (unit tests: no payload, another version, an asset load error, 30 s without
      ready: each a `page-failed` overlay naming the cause). The CSP negative control (2.8) shows it in a real host.

## 3. Data flow

- [x] 3.1 Request the view model through `003`'s helper, keyed on document URI
      and version; coalesce document changes
      One `CoalescedRefresh` per editor, keyed on its document URI; a request per settled document version, and an
      answer overtaken by a newer request is dropped (unit test). Desktop smoke: 132 keystrokes, 1 request.
- [x] 3.2 Post `renderBundle` with the server's payload **verbatim**, plus the
      editor's current view mode and display settings
      `renderBundle` with `flowGraph` and `serviceGraph` by reference plus `viewMode` and `displaySettings`, after
      `webviewReady`. Smoke, both hosts: the posted graphs equal a fresh `eventFlowViews` answer field for field.
- [x] 3.3 Post `setViewMode` and `setDisplaySettings` when the user changes them
      Title-bar commands post `setViewMode` and `setDisplaySettings`. Smoke, both hosts: the page switches to the
      service nodes and shows labels as written.
- [x] 3.4 Keep the last good diagram on screen while a new one is in flight
      Unit test. Desktop smoke: while the flow is broken the page keeps the last nodes under an `unreadable` banner,
      and no overlay appears while typing.
- [x] 3.5 Re-render when the document changes on disk, not only in the editor
      Open text documents reload from disk; a file watcher covers the rest. Desktop smoke: rewriting
      `place-order-flow.zfl` on disk adds `diskAuditOrder` to the rendered page.
- [x] 3.6 Add a test that fails if the payload is inspected or reshaped on the
      way through — this is the requirement most likely to erode
      test/unit/eventflow.test.ts: the graphs are Proxies whose every trap throws, passed through `ZenwaveRequests` and
      the session; the test fails on any access, and unless the same objects arrive. Negative controls: spreading
      `flowGraph`, and reading `flowGraph.nodes.length` for a log line, each fail it.
- [x] 3.7 Log request outcomes to the output channel; never log the model itself
      `describeOutcome` lines (`EventFlow diagram for place-order-flow.zfl: rendered`, `… could not read …`, `… needs
      the ZenWave language server …`, page loaded or failed). A unit test asserts no model content; the desktop runner
      checks the output channel.

## 4. Controls

- [x] 4.1 Flow / service toggle and humanised-labels toggle as commands
      contributed twice to `editor/title` with complementary `when` clauses,
      scoped to the active diagram editor
      `zenwave.eventflow.showServiceView`/`showFlowView` and `showLabelsAsWritten`/`showHumanizedLabels` in
      `editor/title`, with complementary `when` clauses on `activeCustomEditorId == zenwave.eventflow` and
      `zenwave.eventflowViewMode` / `zenwave.eventflowHumanizeLabels` (unit test).
- [x] 4.2 Per-editor state, so two open diagrams keep independent choices
      State lives in each editor's `DiagramSession`; the context keys follow the focused one. Unit test, and smoke in
      both hosts: `place-order-flow.zfl` stays on services while `checkout.zfl` opens on flow.
- [x] 4.3 Show the current view in the editor, so the toggle's state is readable
      The title-bar toggle shows the current state: an icon per view and the title "Showing Flow View: Switch to
      Service View" (likewise for labels). Whether it reads well is in MANUAL TESTS.
- [x] 4.4 `zenwave.eventflow.defaultView` and
      `zenwave.eventflow.humanizeLabels` settings for the initial state
      `zenwave.eventflow.defaultView` (`flow`|`services`) and `zenwave.eventflow.humanizeLabels` (default true), read
      when a diagram opens (unit tests for the manifest and the initial `renderBundle`).

## 5. Empty states

- [x] 5.1 Distinct states: no server, unsupported by this server, document
      unreadable, loading, page failed to load
      `loading`, `no-server`, `unsupported`, `unreadable`, `not-found`, `unsupported-document`, `failed`,
      `page-failed` (`src/eventflow/diagram-state.ts`, keyed on the `RequestResult` kind and `documentFailure`; unit
      test: all distinct). Desktop smoke: `no-server` as an overlay on a new diagram and a banner on a drawn one.
- [x] 5.2 Each state names what the user can do about it
      Each state has wording and actions (Show Language Server Status, Show Problems, Show Output); the page can run
      only the actions the current state offers (unit test).

## 6. Contributions

- [x] 6.1 `contributes.customEditors` entry and
      `zenwave.eventflow.open` / `zenwave.eventflow.openToSide` commands
      package.json; commands registered (smoke, both hosts).
- [x] 6.2 A `contributes.submenus` entry in `editor/title` gathering the ways to
      view a model — shared with `005`, so agree the shape once
      Submenu `zenwave.modelViews` ("ZenWave: View Model", the existing preview icons) in `editor/title` for
      `resourceExtname == .zfl`, holding open beside, open in place and Show ZFL Text; no title-bar icon of its own
      (unit test). The shape for 005 is in design.md §Implementation notes.
- [x] 6.3 A helper that resolves the model document from
      `window.tabGroups.activeTabGroup.activeTab.input`, handling both
      `TabInputText` and `TabInputCustom` — needed by every palette command
      `src/model/active-document.ts` (`activeModelDocument`, `commandDocument`, over `tabDocumentUri`). Smoke, both
      hosts: with a diagram focused and no active text editor, `zenwave.eventflow.open` without arguments resolves
      `checkout.zfl`.
- [x] 6.4 `.vscodeignore` and the build updated to ship the bundle in the VSIX
      `.vscodeignore` already ships `dist/**`; the build copies the page, and `runtime-files.json` lists
      `dist/eventflow-webview/index.html` and `assets/index-*.{js,css}` (patterns now supported by
      `scripts/vsix-contents.mjs`, unit tests). `verify:vsix` on the packaged VSIX: see 7.1.

## 7. Verification

- [x] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
      vscode-platform/client-004: typecheck, lint, unit tests and build pass; packaged once and `verify:vsix` passed.
- [x] 7.2 Opening a `.zfl` file from the explorer still gives the text editor
      See 2.1.
- [x] 7.3 Desktop: open the `place-order-flow.zfl` fixture as a diagram
      Desktop smoke (and browser): `place-order-flow.zfl` opened as a diagram, 47 flow nodes drawn.
- [x] 7.4 The in-place gesture keeps the tab's position; *Reopen Editor With…*
      gets back to the text
      Smoke, both hosts: in place keeps the tab index; `workbench.action.reopenTextEditor` (Reopen Editor With…, Text
      Editor) and Show ZFL Text both put the text back at the same index. The picker UI itself is VS Code's.
- [x] 7.5 Two flows open at once: each keeps its own document and its own view
      See 4.2.
- [ ] 7.6 Reload the window with a diagram open: it comes back
      Open: needs a human (see 2.5).
- [x] 7.7 Edit the fixture: the diagram follows, without flashing empty states
      Desktop smoke: a command typed character by character appears in the page; a broken line shows a banner over
      the kept diagram, never an overlay.
- [x] 7.8 Switch view and labels; edit again; the choices survive
      Desktop smoke: services view and labels as written, typing re-renders, and the last `renderBundle` still
      carries both choices.
- [ ] 7.9 Invoke the preview command while a diagram has focus — the tab-group
      lookup has to find the document with no active text editor
      Open: the preview command is 005's. The tab-group lookup it needs is proven by the 6.3 smoke with a diagram
      focused.
- [x] 7.10 With the server stopped: the diagram says the server is needed
      Desktop smoke: with `zenwave.lsp.enabled` off the open diagram keeps its nodes under a `no-server` banner, and a
      new one shows the `no-server` overlay offering Show Language Server Status; back on, it renders again.
- [ ] 7.11 Offline with the network disabled: the diagram still renders
      Open: needs a human with the network disabled. Automated evidence: the CSP has no `connect-src` and nothing
      remote, the page loads only from the extension (2.7, 2.8), and the smoke reports no CSP violation.
- [ ] 7.12 Compare against the IntelliJ tool window on the same fixture — same
      nodes, same layout
      Open: needs a human with IntelliJ. Note zenwave-lsp spec question 1: JVM and JS ELK node sizes differ, so
      the layouts will not match exactly until dsl-kotlin aligns them.
- [x] 7.13 `npm run run-in-browser`: the editor opens and explains itself rather
      than erroring
      Browser smoke (`@vscode/test-web`, the host `run-in-browser` uses): the diagram opens beside and in place,
      renders, toggles, and highlights from the tree, with the worker server.
- [x] 7.14 `openspec validate 004-eventflow-panel --strict`
      `npx openspec validate --all --strict`.

## 8. Archive

- [ ] 8.1 `openspec archive 004-eventflow-panel`
