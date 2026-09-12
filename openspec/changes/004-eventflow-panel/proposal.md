# 004 — EventFlow diagram editor

## Why

A ZFL file is an event-storming flow, and reading one as text is reading a
diagram in longhand. IntelliJ has had the visual version for a while: a tool
window with the EventFlow visualizer, a flow view and a service map, following
whichever ZFL file you are editing.

VS Code should show the same diagram, from the same renderer, because two IDEs
drawing the same model differently is a bug rather than a feature.

The shape of the work is unusual, and worth stating plainly: **this change adds
almost no logic.** Upstream produces a positioned view model as JSON; the
EventFlow webview bundle renders it. VS Code's job is to host the webview, ask
the server for the JSON, hand it over, and pass a few user-facing toggles
through. Nothing in between inspects, transforms or validates the model — if it
did, this repo would have started growing an opinion about how a flow is drawn,
which belongs to `zenwave-architectural-vistas`.

## What Changes

- A **diagram editor** for ZFL, hosting the upstream EventFlow webview bundle —
  registered as a custom editor, so it can open beside the text or in place of
  it, and lives in the editor area where a diagram has room to be read.
- Each diagram **belongs to its document** and re-renders as that document
  changes.
- **Flow and service views**, and a labels toggle, from the editor's own title
  area, kept per open diagram.
- The **view model passes through untouched**: obtained from the language server,
  forwarded to the webview verbatim.
- **Explained empty states** — no server, unsupported request, unparseable file —
  instead of a blank rectangle.

## Capabilities

### New Capabilities

- `eventflow-panel`: hosting the upstream EventFlow webview inside VS Code as an
  editor for a ZFL document, and relaying view-model data and view controls
  between that editor and the webview.

### Modified Capabilities

None.

## Impact

- **Depends on `003-lsp-client`.** The view model comes from the server; there is
  no second source. The diagram is implementable only once a server answers.
- **Depends on a new server request** producing the flow and service view models
  for a ZFL document. IntelliJ builds this JSON in-process with
  `GenerateFlowViewFromZfl` / `GenerateServiceViewFromZfl`; VS Code needs it over
  the wire. Contract proposed in `zenwave-specs`.
- **Depends on the upstream webview bundle.** `zenwave-architectural-vistas`
  builds it and syncs it into the IntelliJ plugin with `pnpm sync:intellij`. That
  script writes to one hard-coded destination — this repo needs to become a
  second consumer, which is an upstream change, not a copy into this tree.
- **Two integration gaps in the bundle**, both upstream, both found while
  specifying this:
  - the page signals readiness with `window.parent.postMessage`, which does not
    reach a VS Code extension — VS Code webviews post through the API handed to
    the page;
  - the built `index.html` references its assets with relative paths, which a
    VS Code webview must rewrite to `vscode-webview:` URIs under a content
    security policy.
- **`package.json`** — a custom editor registration for `.zfl`, commands, a
  shared ZenWave submenu in the editor title area, and settings for the default
  view.
- **Related change `006-model-explorer`** contributes the conceptual hierarchy
  tree that sits beside the diagram in IntelliJ, and the selection sync into it.
  Neither change blocks the other's core.
