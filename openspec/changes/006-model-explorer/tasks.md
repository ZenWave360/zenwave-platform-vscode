# 006 — Tasks

## 1. Prerequisites

- [ ] 1.1 `003-lsp-client` implemented — both trees are server-fed
- [ ] 1.2 `zenwave-specs`: `zenwave/hierarchy` written down as a contract, since
      this is its second consumer and its first over a wire
- [ ] 1.3 **Upstream:** hierarchy answered for a document that is not open —
      `withEntry` returns nothing today, so the architecture tree is empty
- [ ] 1.4 **Upstream:** hierarchy nodes that point at the document declaring
      them — every node currently carries the requested URI
- [ ] 1.5 **Upstream:** a way to match a hierarchy node to a view-model node, or
      the diagram highlight cannot work
- [ ] 1.6 Reconsider the Model tree's scope once `003` lands and the Outline
      shows the same hierarchy for an open document
- [ ] 1.7 `004-eventflow-panel` for the selection-sync tasks only; everything
      else here is independent

## 2. Container and views

- [ ] 2.1 A ZenWave view container in the activity bar, with an icon
- [ ] 2.2 `Architecture` and `Model` tree views inside it
- [ ] 2.3 Activation on the views, so opening the container starts the extension
- [ ] 2.4 `viewsWelcome` entries keyed on the context keys `003` publishes:
      no server, no manifest, no model open

## 3. The shared provider

- [ ] 3.1 A `TreeDataProvider` over hierarchy nodes, parameterised by root
      resolution
- [ ] 3.2 Map a node to a tree item: label, icon from `kind` and `uiHints`,
      `contextValue` from `kind`, `id` retained for highlighting
- [ ] 3.3 An unknown `kind` renders with a neutral icon rather than being dropped
      — test it with a made-up kind
- [ ] 3.4 `getParent`, so `reveal()` works
- [ ] 3.5 Coalesce refreshes on document change, as the diagram does
- [ ] 3.6 Report request outcomes to the output channel

## 4. Architecture tree

- [ ] 4.1 Resolve the root from `zenwave/workspaceStatus().manifestUri` — the
      manifest `003` resolved, so the tree shows what the server is working
      against
- [ ] 4.2 Ask only about that URI — never about every YAML in the workspace
- [ ] 4.3 Refresh when the manifest changes on disk
- [ ] 4.4 Populate with no editor open
- [ ] 4.5 The no-manifest welcome state links to the manifest setting

## 5. Model tree

- [ ] 5.1 Resolve the active model document through
      `window.tabGroups.activeTabGroup.activeTab.input`, handling both
      `TabInputText` and `TabInputCustom`
- [ ] 5.2 Ignore tabs that are not model documents, keeping the last model shown
- [ ] 5.2b Do not retarget when the focused document is already part of the
      hierarchy on screen — match on the nodes' `sourceUri`
- [ ] 5.2c Test the drill-in case end to end: flow tree, select a system, land in
      the ZDL, tree still shows the flow
- [ ] 5.3 Name the shown document in the view's description
- [ ] 5.4 Verify it stays populated while a preview or a diagram has focus —
      the scenario the standard Outline cannot serve

## 6. Navigation and selection

- [ ] 6.1 Selecting a node opens `sourceUri` at `sourceRange`, including when
      that is a different document from the one the tree is showing
- [ ] 6.2 `relatedResources` offered as context-menu actions
- [ ] 6.3 Cursor movement in a model document reveals the matching node
- [ ] 6.4 Tree selection posts `highlightNode` to a diagram open for the same
      document; clearing the selection clears the highlight
- [ ] 6.5 Selecting with no diagram open still navigates, and reports nothing

## 7. Verification

- [ ] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] 7.2 Architecture tree shows domains and subdomains from a manifest, with no
      editor open
- [ ] 7.3 Model tree on the `place-order-flow.zfl` fixture shows systems declared
      in the annotated ZDL files, and commands under their services
- [ ] 7.4 Compare the tree against IntelliJ's Conceptual Hierarchy on the same
      fixture
- [ ] 7.5 Navigate to a node declared in another file
- [ ] 7.6 Focus a diagram: the model tree stays populated
- [ ] 7.7 Select in the tree: the diagram highlights
- [ ] 7.8 With the server stopped: both trees explain themselves
- [ ] 7.9 With no manifest: the architecture tree says so, offers the setting,
      and the model tree still works
- [ ] 7.10 A multi-root workspace mirroring `arcadia-editions`: the architecture
      tree shows the one architecture whichever folder is focused
- [ ] 7.11 A large model: typing does not make the tree thrash
- [ ] 7.12 `openspec validate 006-model-explorer --strict`

## 8. Archive

- [ ] 8.1 `openspec archive 006-model-explorer`
