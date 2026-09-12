# 004 — Tasks

## 1. Upstream prerequisites

- [ ] 1.1 `003-lsp-client` implemented — the view model has no other source
- [ ] 1.2 `zenwave-lsp`: a request returning the flow and service view models for
      a ZFL document (contract in `zenwave-specs`)
- [ ] 1.3 `zenwave-architectural-vistas`: the EventFlow webview bundle reaches
      this repo — a second sync target, or published as an npm package
- [ ] 1.4 `zenwave-architectural-vistas`: the page posts `webviewReady` through
      the VS Code webview API when present, falling back to `window.parent`
- [ ] 1.5 Agree how the bundle version is pinned, so a protocol change cannot
      break the diagram silently

## 2. Diagram editor

- [ ] 2.1 Register a custom editor for `.zfl` with `priority: "option"` — verify
      that opening a flow file still gives the text editor
- [ ] 2.2 Open it in the adjacent column for the beside gesture, focus staying in
      the text editor
- [ ] 2.3 Open it in the current column for the in-place gesture, so the tab
      keeps its position
- [ ] 2.4 Name the document in the editor's tab
- [ ] 2.5 Confirm VS Code restores the diagram on window reload
- [ ] 2.6 Never move or re-position an editor after opening it
- [ ] 2.7 Serve the bundle directory as a local resource root; rewrite the built
      page's asset references to webview URIs
- [ ] 2.8 A content security policy that allows the bundle and nothing remote
- [ ] 2.9 Retain webview state while the editor is hidden; measure the cost with
      several diagrams open
- [ ] 2.10 Treat `webviewReady` as the signal that the page loaded; report a load
      failure as an error state rather than a blank editor

## 3. Data flow

- [ ] 3.1 Request the view model through `003`'s helper, keyed on document URI
      and version; coalesce document changes
- [ ] 3.2 Post `renderBundle` with the server's payload **verbatim**, plus the
      editor's current view mode and display settings
- [ ] 3.3 Post `setViewMode` and `setDisplaySettings` when the user changes them
- [ ] 3.4 Keep the last good diagram on screen while a new one is in flight
- [ ] 3.5 Re-render when the document changes on disk, not only in the editor
- [ ] 3.6 Add a test that fails if the payload is inspected or reshaped on the
      way through — this is the requirement most likely to erode
- [ ] 3.7 Log request outcomes to the output channel; never log the model itself

## 4. Controls

- [ ] 4.1 Flow / service toggle and humanised-labels toggle as commands
      contributed twice to `editor/title` with complementary `when` clauses,
      scoped to the active diagram editor
- [ ] 4.2 Per-editor state, so two open diagrams keep independent choices
- [ ] 4.3 Show the current view in the editor, so the toggle's state is readable
- [ ] 4.4 `zenwave.eventflow.defaultView` and
      `zenwave.eventflow.humanizeLabels` settings for the initial state

## 5. Empty states

- [ ] 5.1 Distinct states: no server, unsupported by this server, document
      unreadable, loading, page failed to load
- [ ] 5.2 Each state names what the user can do about it

## 6. Contributions

- [ ] 6.1 `contributes.customEditors` entry and
      `zenwave.eventflow.open` / `zenwave.eventflow.openToSide` commands
- [ ] 6.2 A `contributes.submenus` entry in `editor/title` gathering the ways to
      view a model — shared with `005`, so agree the shape once
- [ ] 6.3 A helper that resolves the model document from
      `window.tabGroups.activeTabGroup.activeTab.input`, handling both
      `TabInputText` and `TabInputCustom` — needed by every palette command
- [ ] 6.4 `.vscodeignore` and the build updated to ship the bundle in the VSIX

## 7. Verification

- [ ] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] 7.2 Opening a `.zfl` file from the explorer still gives the text editor
- [ ] 7.3 Desktop: open the `place-order-flow.zfl` fixture as a diagram
- [ ] 7.4 The in-place gesture keeps the tab's position; *Reopen Editor With…*
      gets back to the text
- [ ] 7.5 Two flows open at once: each keeps its own document and its own view
- [ ] 7.6 Reload the window with a diagram open: it comes back
- [ ] 7.7 Edit the fixture: the diagram follows, without flashing empty states
- [ ] 7.8 Switch view and labels; edit again; the choices survive
- [ ] 7.9 Invoke the preview command while a diagram has focus — the tab-group
      lookup has to find the document with no active text editor
- [ ] 7.10 With the server stopped: the diagram says the server is needed
- [ ] 7.11 Offline with the network disabled: the diagram still renders
- [ ] 7.12 Compare against the IntelliJ tool window on the same fixture — same
      nodes, same layout
- [ ] 7.13 `npm run run-in-browser`: the editor opens and explains itself rather
      than erroring
- [ ] 7.14 `openspec validate 004-eventflow-panel --strict`

## 8. Archive

- [ ] 8.1 `openspec archive 004-eventflow-panel`
