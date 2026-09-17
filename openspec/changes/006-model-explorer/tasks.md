# 006 — Tasks

## 1. Prerequisites

- [x] 1.1 `003-lsp-client` implemented — both trees are server-fed
      Available on the base branch vscode-platform/client-007 (c474a11, stacked on client-003 42a10db):
      `LanguageServerApi.requests.hierarchy(uri)`, `status`, `advertisedRequests`, `manifest`, `onDidChange`.
- [x] 1.2 `zenwave-specs`: `zenwave/hierarchy` written down as a contract, since
      this is its second consumer and its first over a wire
      Exists in the store: `001-ide-client-contracts` spec `lsp-visualization-requests`, requirements "A client can
      request the conceptual hierarchy of a document", "A hierarchy can be asked for without the document being
      open", "A node in a diagram and a node in a hierarchy can be matched" and "A hierarchy node's label is a usable
      default, not a mandate"; wire shape in its design.md §Decision (tasks 2.5–2.8).
- [x] 1.3 **Upstream:** hierarchy answered for a document that is not open —
      `withEntry` returns nothing today, so the architecture tree is empty
      Available (zenwave-lsp d7156e7, store 001 2.6). Desktop smoke: the architecture tree populates from the
      unopened `zenwave-architecture.yml` with no editor open. Caveat, browser: a server in a Web Worker reads only
      `http(s)` documents it was not sent, so an unopened `vscode-test-web:`/`vscode-vfs:` manifest answers
      `documentNotFound`; the browser smoke asserts the tree's explained `not-found` state instead.
- [x] 1.4 **Upstream:** hierarchy nodes that point at the document declaring
      them — every node currently carries the requested URI
      Available (store 001 2.5). Smoke, both hosts: `checkout.zfl`'s system `Orders` points at
      `lsp/orders/model.zdl`; `place-order-flow.zfl`'s `OrdersCheckout` at `orders-checkout-api/domain-model.zdl`.
- [x] 1.5 **Upstream:** a way to match a hierarchy node to a view-model node, or
      the diagram highlight cannot work
      Available (store 001 2.8): `viewNodeIds`. Smoke, both hosts: the tree selection revealed from the cursor
      sends `policy:OrderCreated:notifyCustomer` and `event:CheckoutStarted` to a panel registered for the flow.
- [ ] 1.6 Reconsider the Model tree's scope once `003` lands and the Outline
      shows the same hierarchy for an open document
      Reconsidered: keep the full scope (design.md §Decision (task 1.6), decided by agent on 2026-09-17, pending review).
- [x] 1.7 `004-eventflow-panel` for the selection-sync tasks only; everything
      else here is independent
      Available on vscode-platform/client-004: the EventFlow diagram editor registers each diagram with
      `DiagramPanels` once its page reports `webviewReady`, and posts `highlightNode` to it (see 6.4).

## 2. Container and views

- [x] 2.1 A ZenWave view container in the activity bar, with an icon
      `package.json` `viewsContainers.activitybar` `zenwave`, codicon `$(type-hierarchy)` (no new asset);
      smoke `workbench.view.extension.zenwave` in both hosts; unit test `explorer.test.ts` (contributions).
- [x] 2.2 `Architecture` and `Model` tree views inside it
      `zenwave.architecture`, `zenwave.model`; `src/explorer/feature.ts` `registerModelExplorer`.
- [x] 2.3 Activation on the views, so opening the container starts the extension
      `onView:zenwave.architecture`, `onView:zenwave.model` (unit test `lsp-client-status.test.ts`).
- [x] 2.4 `viewsWelcome` entries keyed on the context keys `003` publishes:
      no server, no manifest, no model open
      Keyed on `zenwave.architectureTreeState` / `zenwave.modelTreeState`, which each tree derives from 003's
      `status`, `advertisedRequests` and `manifest` plus its own answer — 003's boolean keys cannot tell a starting
      server, a server without `zenwave/hierarchy` or an unreadable document apart. One entry per state
      (`loading`, `no-server`, `unsupported`, `no-manifest`, `no-model`, `not-found`, `unreadable`, `empty`,
      `failed`), asserted by the unit test; states asserted in both smoke hosts.

## 3. The shared provider

- [x] 3.1 A `TreeDataProvider` over hierarchy nodes, parameterised by root
      resolution
      `HierarchyTree` in `src/explorer/feature.ts`, constructed twice with a `resolveTarget` function.
- [x] 3.2 Map a node to a tree item: label, icon from `kind` and `uiHints`,
      `contextValue` from `kind`, `id` retained for highlighting
      `presentNode` in `src/explorer/hierarchy-model.ts` (unit test); the node, its `id` and `viewNodeIds` stay on
      the element; smoke checks description, icon and `contextValue` of `Orders`.
- [x] 3.3 An unknown `kind` renders with a neutral icon rather than being dropped
      — test it with a made-up kind
      Unit test: kind `saga-step` renders as `Saga Payments` with `circle-small` and `zenwave.hierarchy.saga-step`.
- [x] 3.4 `getParent`, so `reveal()` works
      Unit test (parent links); smoke: the cursor reveals nodes nested three levels down, in both hosts.
- [x] 3.5 Coalesce refreshes on document change, as the diagram does
      `src/explorer/coalesce.ts` `CoalescedRefresh` (400 ms quiet period, never two requests at once, one follow-up
      for edits made during a request). Unit test with a fake clock (200 keystrokes → 1 request; 50 more during a
      slow request → exactly 1 more); smoke, both hosts: 60 edits to the 259-line flow → 1 hierarchy request and 1
      tree update.
- [x] 3.6 Report request outcomes to the output channel
      `describeState` (unit test): every state change is logged (info/warn), repeats at debug; the desktop runner
      checks the channel for the architecture outcome, "no architecture manifest was resolved" and "needs the
      ZenWave language server".

## 4. Architecture tree

- [x] 4.1 Resolve the root from `zenwave/workspaceStatus().manifestUri` — the
      manifest `003` resolved, so the tree shows what the server is working
      against
      Resolved from `languageServer.manifest.manifestUri`: the manifest 003 resolved and initialised the server with,
      re-read on `onDidChange` (a changed manifest restarts the server). Wording deviation: `zenwave/workspaceStatus`
      does not exist in zenwave-lsp d7156e7; the server-reported location is now store 001 task 2.22.
- [x] 4.2 Ask only about that URI — never about every YAML in the workspace
      The architecture tree's only target is `manifest.manifestUri`; it refreshes only for that URI's document
      events and a file watcher on that one file name.
- [x] 4.3 Refresh when the manifest changes on disk
      Desktop smoke: a `billing` domain written into the manifest appears, and disappears when restored.
- [x] 4.4 Populate with no editor open
      Desktop smoke: no tabs open, the tree shows `zenwave-architecture.yml` → `orders`, `fulfillment` → `shipping`.
      Browser: see 1.3 — explained `not-found`, populated once the user runs Open Architecture Manifest.
- [x] 4.5 The no-manifest welcome state links to the manifest setting
      `viewsWelcome` `no-manifest` → `workbench.action.openSettings` `zenwave.workspace.manifest` (unit test);
      desktop smoke reaches the state by deleting `.zenwave/config.yml`.

## 5. Model tree

- [x] 5.1 Resolve the active model document through
      `window.tabGroups.activeTabGroup.activeTab.input`, handling both
      `TabInputText` and `TabInputCustom`
      `tabDocumentUri` / `isModelDocument` in `src/explorer/follow.ts` (unit test with both input shapes; a custom
      editor's document is recognised by extension when not open as text). Smoke uses text tabs; no ZenWave custom
      editor exists yet.
- [x] 5.2 Ignore tabs that are not model documents, keeping the last model shown
      Smoke, both hosts: a Markdown editor and then a webview panel keep `place-order-flow.zfl` on screen.
- [x] 5.2b Do not retarget when the focused document is already part of the
      hierarchy on screen — match on the nodes' `sourceUri`
      `followDecision` (unit test).
- [x] 5.2c Test the drill-in case end to end: flow tree, select a system, land in
      the ZDL, tree still shows the flow
      Smoke, both hosts: `zenwave.explorer.openNode` (the tree item's command) on `Orders` opens
      `lsp/orders/model.zdl` as the active tab; the tree still shows `checkout.zfl`.
- [x] 5.3 Name the shown document in the view's description
      Smoke: `view.description === 'checkout.zfl'`.
- [x] 5.4 Verify it stays populated while a preview or a diagram has focus —
      the scenario the standard Outline cannot serve
      Smoke, both hosts (client-004): with the `checkout.zfl` EventFlow diagram focused (a `TabInputCustom`, no
      active text editor) the model tree shows `checkout.zfl` in state `ready`; focusing the `place-order-flow.zfl`
      diagram retargets it there. A focused plain webview keeps the tree too. The preview (005) is the same tab
      shape and should repeat this check when it lands.

## 6. Navigation and selection

- [x] 6.1 Selecting a node opens `sourceUri` at `sourceRange`, including when
      that is a different document from the one the tree is showing
      Smoke, both hosts: `OrderService` opens `lsp/orders/model.zdl` with the cursor on its declaration line.
      Uses `src/model/navigation.ts` (`openLocation` gained `preserveFocus`).
- [x] 6.2 `relatedResources` offered as context-menu actions
      `zenwave.explorer.openRelated` in `view/item/context` for `viewItem =~ /\.related$/`, quick pick when several.
      Smoke: `referenced-by` opens the flow, `declares-domain` the ZDL, a node without any reports so.
- [x] 6.3 Cursor movement in a model document reveals the matching node
      `nodeAt` (unit test) + `revealCursor`. Smoke, both hosts: cursor in `when OrderCreated` selects that policy;
      in `start CheckoutStarted` the start node.
- [x] 6.4 Tree selection posts `highlightNode` to a diagram open for the same
      document; clearing the selection clears the highlight
      `DiagramPanels` (`src/explorer/diagram-selection.ts`), filled by the 004 editor (`src/eventflow/feature.ts`).
      Smoke, both hosts, against the real vistas page (the fake panel is gone): the cursor in `start CheckoutStarted`
      selects the node and the page renders `event:CheckoutStarted` with `eventflow-node-highlighted`; selecting
      `startOrderCheckout` in the place-order tree highlights `command:startOrderCheckout`, and selecting a node
      without a counterpart clears the page's highlight. Closing the diagram unregisters it. An emptied selection
      sending `null` is unit-tested (the tree API cannot empty a selection).
- [x] 6.5 Selecting with no diagram open still navigates, and reports nothing
      Unit test (`no-diagram`, no panel called); smoke navigations run with no panel registered and show nothing.

## 7. Verification

- [x] 7.1 `npm run typecheck`, `npm run lint`, `npm run build`
      vscode-platform/client-006.
- [x] 7.2 Architecture tree shows domains and subdomains from a manifest, with no
      editor open
      Desktop smoke (fixture manifest gained domain `fulfillment` with subdomain `shipping`).
- [x] 7.3 Model tree on the `place-order-flow.zfl` fixture shows systems declared
      in the annotated ZDL files, and commands under their services
      Smoke, both hosts: five systems; `OrdersCheckout` declared in `orders-checkout-api/domain-model.zdl` (fixture
      added — the annotated files did not exist) with `startOrderCheckout, confirmOrder, cancelOrder`;
      `PaymentsProcessingService` with its `when` commands. The other four ZDL files still do not exist, so those
      systems stay in the flow.
- [ ] 7.4 Compare the tree against IntelliJ's Conceptual Hierarchy on the same
      fixture
      Open: needs a human with IntelliJ.
- [x] 7.5 Navigate to a node declared in another file
      See 6.1 and 5.2c.
- [x] 7.6 Focus a diagram: the model tree stays populated
      See 5.4 (smoke, both hosts, client-004).
- [x] 7.7 Select in the tree: the diagram highlights
      See 6.4 (smoke, both hosts, client-004: the highlight is read back from the rendered page).
- [x] 7.8 With the server stopped: both trees explain themselves
      Desktop smoke: `zenwave.lsp.enabled` off → both trees `no-server` with no nodes (welcome entry per state,
      unit test), both repopulate when it is back on.
- [x] 7.9 With no manifest: the architecture tree says so, offers the setting,
      and the model tree still works
      Desktop smoke: `.zenwave/config.yml` deleted → `no-manifest`, model tree still shows `checkout.zfl`.
- [ ] 7.10 A multi-root workspace mirroring `arcadia-editions`: the architecture
      tree shows the one architecture whichever folder is focused
      Open: needs a human with a multi-root workspace. By construction the tree asks only about 003's single
      workspace manifest, which does not depend on the focused folder.
- [ ] 7.11 A large model: typing does not make the tree thrash
      Open: needs a human with a large model. Automated evidence in 3.5 (259-line flow, 60 edits → 1 request).
- [x] 7.12 `openspec validate 006-model-explorer --strict`

## 8. Archive

- [ ] 8.1 `openspec archive 006-model-explorer`
