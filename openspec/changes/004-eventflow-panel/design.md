# 004 — Design

## Context

The IntelliJ implementation is the reference, and reading it settles most of the
design by showing how little of it is IDE work:

```
ZflToolWindowController          session tracking, debounce, orchestration
  └ ZflDiagramModelProvider      Kotlin: GenerateFlowViewFromZfl
                                         GenerateServiceViewFromZfl
                                 → {"flowGraph": …, "serviceGraph": …}
  └ ZflJcefDiagramHost           JCEF browser + local resource handler
                                 → window.postMessage({type, payload})
```

Everything interesting happens in Kotlin upstream or inside the webview bundle.
The plugin is a pipe with a toolbar.

VS Code has the same shape with two substitutions: the view model comes over LSP
instead of from an in-process Kotlin call, and JCEF becomes a VS Code webview.

The webview's message contract is already fixed by the bundle
(`apps/eventflow-webview`):

| Direction | Message | Payload |
| --- | --- | --- |
| host → page | `renderBundle` | `flowGraph`, `serviceGraph`, `viewMode`, `displaySettings` |
| host → page | `setViewMode` | `viewMode`: `flow` \| `services` |
| host → page | `setDisplaySettings` | `displaySettings`, e.g. `humanizeLabels` |
| host → page | `highlightNode` | `nodeId`, or `null` to clear |
| page → host | `webviewReady` | — |

Messages arriving before React mounts are queued in
`window.__eventFlowPendingMessages` and applied on mount, so the host does not
have to wait for readiness before sending. That is worth knowing, because the
`webviewReady` signal is also the one thing that does not work in VS Code — see
below.

## Goals / Non-Goals

**Goals:**

- The same diagram as IntelliJ, from the same bundle, with no second renderer.
- A diagram that is a transport, not an interpreter.
- A place to put a diagram where it has room to be read.
- Empty states that name the cause, since three different upstream gaps can each
  produce a blank diagram.

**Non-Goals:**

- **The conceptual hierarchy tree.** IntelliJ's tool window has one beside the
  diagram; in VS Code it is a separate view in its own container, specified in
  `006-model-explorer`. The selection sync between the two lives there too,
  because the tree is the half that knows about selection.
- **Editing the model from the diagram.** The bundle takes `editable={true}`,
  but round-tripping edits back into ZFL text is a separate capability with its
  own contract.
- **Clicking a node to jump to the source.** The view model carries `sourceRef`
  and the wiring is tempting, but the bundle has no outbound message for it. That
  is an upstream addition; see the risks.
- **Producing the view model.** Not ours. This is the whole point.

## Decisions

### The diagram is a custom editor, not a panel view

An earlier draft of this design put the diagram in a view container, reasoning
from IntelliJ's tool window. That was wrong, for a reason that only shows up when
you try to use it: a tool window in IntelliJ is *docked and sized*, and VS Code's
nearest equivalent — a view in the bottom panel, beside Terminal and Problems —
is a strip that is awkward to give real height to. A flow diagram needs area.

Registering the diagram as a **custom editor** for `.zfl`
(`contributes.customEditors` with `priority: "option"`) puts it in the editor
area instead, which is the largest surface VS Code has, and which the user can
already split, drag and maximise with gestures they know. It ends up more
flexible than the docked tool window, not less.

It also makes `004` and `005` the same shape. Two features that open a rendered
view of a model document should not arrive as two different kinds of thing.

`priority: "option"` is not optional: with `"default"`, opening a `.zfl` file
would show a diagram instead of the flow, and ZFL would become a language you
cannot edit by double-clicking.

### Being an editor deletes a feature

IntelliJ's tool window needs `Flow:` — a file selector — and a session tracker to
decide which document it is showing, because a tool window is attached to nothing.

A custom editor is attached to a document by construction. So the selector, the
session tracking, the "what happens when the shown document closes" logic, and
the retargeting all disappear. The tab *is* the selection, and two flows open at
once are two tabs.

This is the single biggest simplification in the change, and it is worth naming
so that nobody ports `ZflToolWindowController` faithfully.

### View controls go in the editor's title area, not inside the webview

`View: Flow | Services` and humanised labels are both two-valued. The idiom for
that in VS Code is a command contributed twice to `editor/title` with
complementary `when` clauses over a context key, so the control is a single icon
that flips — one click, where a combo box costs an open and a pick.

Scoping those `when` clauses to the active custom editor keeps them off the text
editor's title bar.

This leaves the webview free of chrome, which matters because the webview is
upstream's and every control we add inside it is a patch on someone else's page.

### One submenu, not three icons

A ZFL document can be opened as text, as a preview (`005`) and as a diagram.
Three separate title-bar icons is clutter, and it gets worse with each feature.

`contributes.submenus` gives one ZenWave icon that opens a list — open beside,
open in place, for each of preview and diagram. And VS Code's own *Reopen Editor
With…* enumerates the registered editors for free once both custom editors exist,
so the return journey needs no contribution at all.

### The active document is found through tab groups

`window.activeTextEditor` is `undefined` whenever a custom editor has focus. With
this change and `005`, that is a common state — a user looking at a diagram and
pressing the key that opens a preview.

`window.tabGroups.activeTabGroup.activeTab.input` is the replacement:
`TabInputText` and `TabInputCustom` both carry `.uri`, and `TabInputCustom` adds
`viewType`. Commands that need "the model document the user is looking at" read
it there, so they work identically from the text, the preview and the diagram.

### The bundle is consumed from upstream, never copied into this tree

`zenwave-architectural-vistas` owns the renderer and states the dependency rule
plainly: visualization packages must not depend on the IDE plugins. Vendoring the
built bundle here would create a third copy of the same React code and let the
two IDEs drift by a version.

`scripts/sync-eventflow-webview.mjs` already takes a `--plugin-dir`, so teaching
it about a second consumer is a small upstream change. Publishing the built
bundle as an npm package would be better still — it would make the version
explicit in a lockfile instead of implicit in whoever last ran the sync — but
either satisfies this design as long as the bytes are produced upstream.

### The editor forwards, and is not allowed to understand

The spec makes this a requirement rather than a note, because it is the one thing
that will be violated by accident. The first "just read `nodes.length` to decide
whether to show the empty state" is how a TypeScript model of a flow gets born.

The practical rule for implementation: the view model crosses this extension as
an opaque payload, and the code that touches it has no type richer than "the JSON
the server sent". If a rendering decision needs to know something about the
model, that is a signal the server should be telling us, not that we should be
looking.

The empty-state decision therefore keys on *what happened during the request* —
no server, unsupported, failed, ok — which is exactly what `003`'s request helper
distinguishes, and never on the content of the result.

> This rule is about the **view model**. It does **not** apply to the hierarchy
> nodes in `006`, where the server deliberately delegates label and icon
> rendering to the client. Different data, opposite division; see that change.

### Two upstream integration gaps, fixed upstream

**Readiness.** `index.html` announces itself with
`window.parent.postMessage({type: "webviewReady"})`. In a VS Code webview the
extension is not the parent frame; the page must post through the object VS Code
hands it. The bundle needs to prefer that object when it exists and fall back to
`window.parent` otherwise — a few lines, and it keeps JCEF working unchanged.

This is not fatal on its own: the pending-message queue means the host can send
`renderBundle` immediately and let the page apply it on mount. But without a
readiness signal the editor cannot distinguish "still loading" from "failed to
load", and the spec requires exactly that distinction.

**Asset URIs.** The built page references `./assets/index-*.js` and
`./assets/index-*.css`. A VS Code webview serves resources from `vscode-webview:`
URIs and enforces a content security policy. The host therefore rewrites those
references when it loads the page, and serves the bundle directory as a local
resource root. The alternative — asking upstream for a `base` the host injects —
is cleaner but couples the bundle to its consumers; rewriting keeps the coupling
on this side, where it belongs.

### Debounce and last-good-diagram

IntelliJ uses a pooled alarm with a cancel-and-reschedule on every session
change. The same behaviour is worth keeping for document changes: coalesce them,
keep the previous diagram on screen while a new one is in flight, and never
render an empty state on the way from one good diagram to the next. That is what
makes a live diagram usable while typing rather than a strobe light.

### Decision (task 1.5): how the bundle version is pinned

Decided by agent on 2026-09-17, pending review.

`@zenwave360/vistas-eventflow-webview` (zenwave-architectural-vistas 2e60d25)
exists as a packable npm package but is not published. The page states the
protocol it speaks: `webview/protocol.json`
(`{"protocol":"zenwave.eventflow.webview","protocolVersion":1}`), the same
values as meta tags in `index.html`, and `webviewReady` carries them as its
payload. The pin works at three points, so a protocol change breaks visibly at
the earliest one it reaches:

1. **Exact package version, pinned in `package.json`, not a dependency.**
   `"zenwaveEventFlowWebview": {"package": "@zenwave360/vistas-eventflow-webview",
   "version": "0.1.0", "protocol": "zenwave.eventflow.webview", "protocolVersion": 1}`,
   the same shape and reasons as 003's `zenwaveLanguageServer` (003 design
   §Decision (task 1.2)): an unpublished package cannot be a lockfile entry that
   resolves anywhere but the machine that linked it. The build takes the
   package from `ZENWAVE_VISTAS_WEBVIEW_DIR` (or an installed copy) and fails,
   naming what to do, when it is missing or another version. Once the package is
   published it becomes an exact-version dependency and the lockfile carries
   the pin; the build check stays.
2. **Protocol version at build time.** The build reads `webview/protocol.json`
   and fails when the page states another protocol or version than the one
   pinned. Upgrading to a page with a new protocol version is therefore a
   deliberate change to this repository (the pin and the code that speaks it),
   never a side effect of taking a newer bundle.
3. **Protocol version at run time.** The editor treats `webviewReady` as the
   page having loaded only when its payload states protocol version 1
   (`src/eventflow/protocol.ts` `readiness`). A page that states no version
   (older than versioning) or another one is a load failure whose message names
   both versions.

The bundle bytes are copied from the package into `dist/eventflow-webview`
(`index.html` and `assets/*.{js,css}`), never committed here. The hashed asset
names are listed in `runtime-files.json` by pattern.

Why not only a runtime check: the VSIX would ship a page the extension cannot
drive, and the first person to learn it would be a user. Why not a version range:
a renderer is not a library with a stable surface; the protocol version is the
compatibility statement, and the exact package version is what makes a build
reproducible.

What is not decided here: whether vistas bumps `protocolVersion` for additive
messages (it states the payload is additive) — that is vistas' 001 1.6.

### Implementation notes

- **Host script.** The editor adds one nonce'd inline script and style to the
  page (`src/eventflow/page.ts`). The script calls `acquireVsCodeApi()` once and
  sets `window.__zenwaveVsCodeApi` before the page's module script runs, so the
  page reuses it. It reports asset load failures (`zenwave.host.loadError`),
  shows the explained states over or above the diagram
  (`zenwave.host.state`), and answers `zenwave.host.probe` with what the page
  rendered (node ids, highlighted ids, text, stylesheets, CSP violations), which
  is how the smoke test reads the rendered page in both hosts. These
  `zenwave.host.*` messages are this extension's; the vistas protocol is not
  changed, and the page ignores unknown message types. The script never
  intercepts or reads the page's messages.
- **CSP.** `default-src 'none'; script-src <cspSource> 'nonce-…'; style-src
  <cspSource> 'nonce-…'; img-src <cspSource> data:; font-src <cspSource>`. No
  `connect-src`, nothing remote, no `unsafe-inline`.
- **Explained states live in the webview, drawn by the host script,** not by the
  upstream page: an overlay when there is nothing to show, a banner above the last
  diagram when there is. Their buttons run only the commands the state offers.
- **Send after ready.** `renderBundle` is posted after `webviewReady` (vistas
  handoff: messages posted before the module script evaluates can be lost). A
  page that does not report ready within 30 s while visible is a load failure.
- **In place** is implemented as: open the diagram in the text tab's group, close
  the text tab (unless it has unsaved changes, which keeps it open), and move the
  diagram to the index the text had. **Show ZFL Text** does the reverse; VS Code's
  *Reopen Editor With…* works as well.
- **The document stays open as text** while a diagram shows it
  (`workspace.openTextDocument`), so a server that reads only open documents (the
  browser worker) has it after the text tab is replaced.
- **The shared submenu** is `zenwave.modelViews` in `editor/title`
  (`when: resourceExtname == .zfl`), groups `0_text` (back to text) and
  `1_eventflow`; 005 adds its entries as `2_preview` and widens the `when` to its
  file types.

## Risks / Trade-offs

- **Three upstream dependencies, all moving.** The server request, the bundle's
  readiness signal, and the bundle's distribution to this repo. Any one of them
  missing leaves the diagram showing an explained empty state — which is why the
  explained empty states are a requirement and not a nicety.
- **The bundle is not versioned for this consumer today.** A synced directory has
  no version. If the message contract changes, this breaks silently. The
  `zenwave-specs` contract is the mitigation: it makes the protocol something
  that can be broken *visibly*.
- **A custom editor is a stronger claim on the file type than a panel.** Get the
  priority wrong, or let a user make the diagram the default editor for `*.zfl`
  through editor associations, and opening a flow stops showing the flow.
- **Three editors competing for one file type**, once `005` lands. The submenu
  keeps the title bar honest, but the *Reopen Editor With…* list grows, and so
  does the chance a user ends up somewhere they did not mean to be. Worth
  watching in the README before it is worth solving in code.
- **A ZFL file has two diagram surfaces, and nothing says which to open.** This
  change gives a flow view and a service view; `005` gives a flowchart plus one
  representation per end outcome, including the alternative paths of the sequence
  diagrams. Both are offered from the same place in the editor title area.

  Deliberately unresolved. The two were built for different questions upstream,
  and what each is *for* is a meaning the team has not settled — so both are
  shown and the distinction is left to emerge from use rather than invented here.
  Expect users coming from IntelliJ to reach for EventFlow and never find the
  preview's tabs. When the answer is known it belongs in the naming and the
  grouping, not in a new feature.
- **No source navigation, initially.** Users who know the IntelliJ tool window
  will expect clicking a node to do something. Worth saying so in the README
  rather than letting them discover it.
- **Webview memory.** A React renderer with a layout engine, kept alive per open
  diagram. Several flows open at once multiplies that, in a way a single tool
  window never did. Retaining state while hidden costs memory; dropping it costs
  a re-render on every tab switch. Start by retaining, and revisit if it shows
  up.
