# 005 — Tasks

## 1. Upstream prerequisites

- [ ] 1.1 `003-lsp-client` implemented
- [ ] 1.2 `zenwave-lsp`: a request returning ordered preview representations for
      a ZDL or ZFL document, with titles, formats and a default
      (contract in `zenwave-specs`)
- [ ] 1.3 `zenwave-lsp` / `dsl-kotlin`: ZDL class diagrams emitted as Mermaid,
      so both IDEs render from one implementation
- [ ] 1.4 Decide the fate of `packages/preview-renderer` — repurpose or remove;
      do not leave it empty

## 2. Preview editor

- [ ] 2.1 Register a custom editor for `.zdl` / `.zw` / `.zfl` with
      `priority: "option"` — verify that opening a model file still gives the
      text editor
- [ ] 2.2 Open it in the adjacent column for the side-by-side gesture, focus
      staying in the text editor
- [ ] 2.3 Open it in the current column for the in-place gesture, so the tab
      keeps its position
- [ ] 2.4 Check what VS Code's own *Reopen Editor With…* switcher offers, and add
      a visible route back to the text only if that is not enough on its own
- [ ] 2.5 Reveal an existing preview rather than opening a second one
- [ ] 2.6 Confirm the preview is restored on window reload without a
      `WebviewPanelSerializer`
- [ ] 2.7 Content security policy: no remote content, no inline script beyond a
      nonce, sanitise server-provided HTML
- [ ] 2.8 Theme from the editor's CSS variables; follow a theme change live
- [ ] 2.9 Preserve scroll position and selected representation across re-renders

## 3. Editor lifecycle

- [ ] 3.1 Name the previewed document in the editor's tab
- [ ] 3.2 Bind the preview to its document; never re-point an open preview at a
      different one
- [ ] 3.3 A helper resolving the model document from
      `window.tabGroups.activeTabGroup.activeTab.input`, handling both
      `TabInputText` and `TabInputCustom`, for the palette commands — shared with
      `004` and `006`
- [ ] 3.4 Never move or re-position an editor after opening it — a preview the
      user dragged elsewhere stays there
- [ ] 3.5 Decide what happens for an untitled buffer, a model open in a diff,
      and the same model open in two groups

## 4. Content

- [ ] 4.1 Request representations through `003`'s helper, keyed on document URI
      and version; coalesce document changes
- [ ] 4.2 Render the representations in the order given, under the server's
      titles, starting on the server's default
- [ ] 4.3 Hide the selector when there is only one representation
- [ ] 4.4 Keep the last good render on screen while a new one is in flight
- [ ] 4.5 Re-render when the document changes on disk, not only in the editor

## 5. Rendering

- [ ] 5.1 Markdown to HTML, with fenced Mermaid blocks rendered as diagrams
- [ ] 5.2 Mermaid representations rendered directly
- [ ] 5.3 HTML representations inserted sanitised
- [ ] 5.4 Bundle Mermaid; load it on first diagram rather than on panel open
- [ ] 5.5 A malformed diagram reports itself and leaves the rest readable
- [ ] 5.6 Mermaid themed for light and dark

## 6. Empty states and contributions

- [ ] 6.1 Distinct states: no server, unsupported by this server, document
      unreadable, loading
- [ ] 6.2 `contributes.customEditors` entry, and `zenwave.preview.openToSide` /
      `zenwave.preview.open` commands for the two gestures
- [ ] 6.3 Contribute into the shared ZenWave submenu `004` establishes — not a
      title-bar icon of its own — plus palette entries; reuse the existing
      preview icons in `resources/` for the submenu items
- [ ] 6.4 A command opening a quick pick of representations, as a keyboard route
      to the in-webview selector
- [ ] 6.5 Keybinding matching the platform's preview convention, if it does not
      collide with the built-in Markdown preview

## 7. Verification

- [ ] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] 7.2 Opening a `.zdl` file from the explorer still gives the text editor
- [ ] 7.3 Desktop: preview both fixtures; ZFL shows a flowchart and one
      representation per outcome
- [ ] 7.4 The in-place gesture keeps the tab's position; *Reopen Editor With…*
      gets back to the text
- [ ] 7.5 Two models previewed at once: each keeps its own document
- [ ] 7.6 Reload the window with a preview open: it comes back
- [ ] 7.7 Drag the preview to another group: it stays put across re-renders
- [ ] 7.8 Invoke the preview command while a diagram has focus — the tab-group
      lookup has to find the document with no active text editor
- [ ] 7.9 Edit a fixture: the preview follows without blanking
- [ ] 7.10 Switch representation, keep editing: the choice holds
- [ ] 7.11 Switch theme with the preview open: it follows
- [ ] 7.12 Clean VS Code profile with no other extensions: diagrams render
- [ ] 7.13 Network disabled: diagrams render
- [ ] 7.14 With the server stopped: the preview explains
- [ ] 7.15 Compare with IntelliJ's preview on the same fixtures
- [ ] 7.16 Measure the VSIX size against `004`'s bundle and record it
- [ ] 7.17 `openspec validate 005-model-preview --strict`

## 8. Archive

- [ ] 8.1 `openspec archive 005-model-preview`
