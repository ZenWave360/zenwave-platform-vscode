# 005 — Design

## Context

Three prior implementations to learn from, one of them ours.

**IntelliJ** models the preview as a list of representations with a selector:

```kotlin
CompositeMarkdownPreview(
  representations = [ MarkdownPreviewRepresentation(id, title, content, format) ],
  defaultRepresentationId = …
)
enum PreviewContentFormat { MARKDOWN, HTML, MERMAID }
```

ZDL yields one PlantUML representation; ZFL yields a flowchart plus one sequence
diagram per end outcome, with a render-mode selector in the header. That shape —
ordered representations, a nominated default, a declared format — is a good
contract and the spec adopts it, because it is already proven in one IDE and it
puts the naming of representations where the model knowledge is.

**`zdl-vscode`** did the opposite: `renderZdlMarkdown` built Markdown from
Handlebars inside the extension, served it through a `TextDocumentContentProvider`
under a `zdl-preview` scheme, and handed it to `markdown.showPreviewToSide`.
Cheap, and wrong in two ways that matter — the extension became the author of the
diagrams, and the built-in Markdown preview renders no Mermaid without a
third-party extension.

**This project** settled Mermaid over PlantUML (no JVM, no third-party rendering
service) and settled that preview content is produced in the server. Those two
decisions together determine nearly everything below.

## Goals / Non-Goals

**Goals:**

- One implementation of what a model looks like, upstream, serving both IDEs.
- A preview that works on a clean VS Code install, offline.
- Parity with IntelliJ's representation tabs.
- The gestures IntelliJ's layout buttons offer — the preview beside the code, or
  in place of it — reachable in VS Code's own vocabulary rather than imitated.

**Non-Goals:**

- **Porting the Handlebars renderer.** `project.md` called for it behind a
  `PreviewProvider` interface as an interim step. That interim is no longer worth
  paying for: it would ship a renderer whose only purpose is to be deleted, and
  in the meantime it would be the second opinion about what a model looks like.
  The `PreviewProvider` interface survives in spirit — the server is the provider.
- **Scroll synchronisation** between text and preview. IntelliJ does not do it
  either, and it needs source mapping the representations do not carry yet.
- **Exporting** to PNG, SVG or a file.
- **Previewing an unopened file** from the explorer. The preview follows an
  editor.
- **Reproducing IntelliJ's three-layout toggle as a compound editor.** The
  gestures are offered; the single-tab-two-halves construction is not available
  and is not faked.
- **Owning where the user's tabs live.** The preview opens where it is asked to
  open and does not move, restore or re-position tabs afterwards.

## Decisions

### An owned webview, not the built-in Markdown preview

`docs/architecture.md` left this to be settled here. Settled: an owned webview.

The built-in preview cannot render Mermaid without `bierner.markdown-mermaid`
installed, and "install another extension for diagrams to work" is not an
acceptable first-run experience for a feature whose whole point is the diagrams.
An owned webview also gives the representation tabs, which the built-in preview
has nowhere to put.

The cost is real: Markdown-to-HTML rendering, theming, a content security policy,
and a scroll position to preserve — all things the built-in preview handles. That
cost buys a preview that works out of the box, and it is paid once.

Consequence: the `zdl-preview` virtual-document scheme from `zdl-vscode` does not
come across. Nothing depends on it.

### The webview is a custom editor, not a standalone panel

A standalone webview panel opened `Beside` is the obvious VS Code idiom, and it
is what `zdl-vscode` and most preview extensions do. It is not the best fit here,
because IntelliJ's preview is not a panel — it is half of an editor.

`ZdlSplitEditorProvider` composes a `TextEditor` and a `ZdlPreviewEditor` into one
`TextEditorWithPreview` and returns `FileEditorPolicy.HIDE_DEFAULT_EDITOR`. The
three buttons in its top-right corner are that editor's layouts — `SHOW_EDITOR`,
`SHOW_EDITOR_AND_PREVIEW`, `SHOW_PREVIEW` — and the chosen layout is saved as
part of the tab's state. One tab, two halves, always together.

Registering the preview as a **custom editor** for `.zdl` / `.zw` / `.zfl`
(`contributes.customEditors` with `priority: "option"`, plus
`registerCustomEditorProvider`) gets closer to that than a panel does, and buys
three things a panel cannot:

- **Swapping the tab's content**, which is IntelliJ's `SHOW_PREVIEW` button. The
  same tab, same position, text replaced by preview.
- **Getting back to the text for free.** VS Code's own *Reopen Editor With…*
  switcher appears as soon as a resource has more than one registered editor, so
  the return journey is built in rather than something to design.
- **Restoration on window reload**, which VS Code does for custom editors and
  which a standalone webview panel needs a hand-written `WebviewPanelSerializer`
  to fake.

One custom editor covers every gesture; only the column differs. Opening it in
the adjacent column is the side-by-side preview, and opening it in the current
column replaces the text.

`priority: "option"` is not optional. With `"default"`, opening a `.zdl` file
would show the preview instead of the code, and ZDL would become a language you
cannot edit by double-clicking.

### One tab with two halves is not reproducible, and the spec says so

VS Code has no API to compose two editors into a single tab, and none to put the
real text editor inside a webview. IntelliJ's `SHOW_EDITOR_AND_PREVIEW` therefore
has no exact counterpart: side-by-side means two tabs in two groups, and the user
can move, reorder or close them independently.

Rather than pretend otherwise, the spec asks for the part that is reachable — the
preview is an editor for its document, names it, and shows nothing else.

An earlier draft of this design had the preview *follow* the active model
document, carried over from thinking of it as a panel. That is wrong for a custom
editor and would have been a bug: a custom editor is constructed for a URI, and a
preview that re-pointed itself would mean two tabs claiming to be editors of
different documents while showing the same one. The built-in Markdown preview
offers both behaviours and needs a locking command to reconcile them; binding
from the start means never introducing that concept.

The alternative, an "always together" illusion built by forcing tab positions and
re-opening tabs the user closed, would fight the editor. VS Code users expect
tabs to stay where they put them; a preview that keeps springing back is worse
than one that is honestly independent.

### Commands find their document through tab groups

`window.activeTextEditor` is `undefined` whenever a custom editor has focus — a
preview, or a diagram from `004`. So a palette command like "open the preview for
what I am looking at" cannot use it.

`window.tabGroups.activeTabGroup.activeTab.input` can: `TabInputText` and
`TabInputCustom` both carry `.uri`. Invoked from the editor title area the URI
arrives as an argument, but the palette route needs this, and it is the same
helper `004` and `006` need.

### The representation selector lives inside the webview

IntelliJ builds a real toolbar above the preview — `JBLabel("Preview:")` and a
`ComboBox` of representations, with `createHeaderOptionsComponent()` as the hook
ZFL uses to add its `Mode:` selector — and hides it when there is only one
representation.

VS Code's editor title bar holds commands with a static icon or label. It cannot
show a dropdown carrying its current value, and the representation list is
dynamic: one entry per end outcome, under titles the server chose. So the
selector is HTML inside the webview, which is also what looks closest to the
IntelliJ toolbar.

Title-bar commands still earn their place as a second route — a keybinding and a
palette entry that open a quick pick — but they are an accelerator, not the
primary control.

### The server names the representations; the extension lays them out

The request returns representations in order, each with an id, a title and a
format, plus the id to show first. The extension renders and arranges them, and
never decides that a flowchart should come before a sequence diagram, or what a
sequence diagram is called.

This is the same division as `004`, for the same reason, and it has the same
failure mode: the first piece of code that switches on a representation id to
decide something is where model knowledge starts leaking back in. Formats are the
exception — the extension has to know whether it is being handed Markdown, HTML
or Mermaid in order to render it, which is why `format` is part of the contract
rather than something inferred from the content.

### Rendering by declared format

- **Markdown** — rendered to HTML in the webview, with fenced Mermaid blocks
  rendered as diagrams.
- **Mermaid** — rendered directly as a diagram.
- **HTML** — inserted as given, sanitised, under the same policy as everything
  else in the webview.

Mermaid is bundled, not fetched. It is a large library and it dominates the VSIX
size; loading it lazily on the first diagram keeps the preview responsive for
Markdown-only content, but it ships either way.

The server producing HTML is the escape hatch for representations that outgrow
Markdown. It is the least safe of the three and the one to treat with suspicion:
sanitised, no scripts, no remote references.

### ZDL diagrams become Mermaid upstream

IntelliJ's ZDL preview calls `ZdlToMarkdownPlugin.generatePlantUML`. This project
does not render PlantUML, so either the server emits Mermaid for ZDL or ZDL has
no diagram in VS Code.

Porting those templates upstream is the answer — both IDEs then get Mermaid, and
IntelliJ loses its dependency on a PlantUML renderer too. Doing it here would put
the templates in the one place that serves a single IDE.

This is the largest piece of upstream work behind this change, and it is not on
this repo's critical path to *review* the spec — only to implement it.

### State lives with the panel, for as long as the panel lives

The selected representation and the scroll position are per-preview, not
persisted across sessions. Reopening a preview starts on the server's default,
which is what IntelliJ does and what makes the server's choice of default
meaningful.

## Risks / Trade-offs

- **Two upstream pieces, one of them substantial.** The preview request is
  mechanical; Mermaid class diagrams for ZDL are a genuine porting effort. Until
  that lands, a ZDL preview may have less to show than IntelliJ's — which the
  spec permits, since the extension shows what the server provides, but users
  comparing the two IDEs will notice.
- **Two diagram surfaces for one ZFL file.** The preview offers a flowchart and a
  representation per end outcome; `004` offers a flow view and a service view.
  Both are reachable from the same grouping and nothing tells a user which
  answers their question. Recorded in `004` as deliberately unresolved: both are
  shown until use tells us what each is for.
- **VSIX size.** Mermaid plus the EventFlow bundle from `004` in the same package
  is a lot of JavaScript for a language extension. Worth measuring before
  publishing, and worth remembering that both exist because the alternative was
  sending users' domain models to a rendering service.
- **`packages/preview-renderer` is now a package without a purpose.** Leaving an
  empty workspace package is how a repo starts lying about its own structure.
  Decide during implementation: repurpose it as the webview's front-end assets,
  or remove it.
- **Rendering untrusted-ish HTML.** The server is local and the user's own, so
  the threat is low, but a preview that executes what it renders is the classic
  webview mistake. Policy first, convenience second.
- **A custom editor is a stronger claim on the file type than a panel.** Get the
  priority wrong, or let a user set the preview as the default editor for `*.zdl`
  through editor associations, and opening a model stops showing the model. The
  first is ours to get right; the second is the user's choice, and the way back
  has to stay obvious — which is the argument for keeping a visible route to the
  text editor rather than relying on the switcher alone.
- **A custom editor sees more document states than a panel does**: an untitled
  buffer, a file open in a diff, a document open twice in two groups. Each is a
  question a standalone panel never had to answer. The spec covers the ones a
  user will actually hit; expect one or two more during implementation.
- **Two editors with nearly identical lifecycles** (`004` and this one): bound to
  their document, debounce, empty states, theming, CSP. Resist sharing them
  prematurely — they will diverge in exactly the ways that make a shared
  abstraction painful — but do notice if the third one appears.

  *An earlier version of this line said "follow the active document", which is the
  behaviour both designs deliberately rejected. It survived a rewrite and would
  have led an implementer straight back into the bug.*
