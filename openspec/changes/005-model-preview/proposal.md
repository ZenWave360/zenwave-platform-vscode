# 005 — Model preview

## Why

Both reference implementations already have this, and neither is reusable as-is.

**IntelliJ** splits the editor: ZDL on the left, a rendered preview on the right,
with tabs for the representations the model supports — a class diagram for ZDL, a
flowchart and one sequence diagram per outcome for ZFL. It is the feature people
mention first when they compare the two plugins.

**`zdl-vscode`** had a version of it, and its shape is exactly what not to do
again: a Handlebars renderer inside the extension writing Markdown into a virtual
document, handed to VS Code's built-in Markdown preview. That made the extension
the author of the diagrams, which meant IntelliJ and VS Code drew the same model
differently, and it inherited a preview that cannot render Mermaid without a
third-party extension installed.

The settled answer is that **the content is produced inside the language server**,
so one implementation serves both IDEs, and VS Code renders what it is given in
its own webview. That makes this change mostly a rendering surface — and it is
the last of the three headline features, because it depends on the same server
connection as the EventFlow panel.

## What Changes

- A **preview editor** for ZDL and ZFL, offered beside the text or in place of
  it — registered as a custom editor, so VS Code's own editor switcher provides
  the way back to the code and restores the preview on reload.
- **Content from the language server**: an ordered set of representations for the
  document, each with a title and a format, and a default selection.
- **Representation tabs** in the preview, mirroring IntelliJ's selector.
- **Mermaid rendered from a bundled library**, so diagrams work with no network,
  no JVM, and no other extension installed.
- The preview **follows and refreshes with the document**, and looks like the
  rest of the editor in both light and dark themes.
- No Handlebars, and no port of the `zdl-vscode` renderer.

## Capabilities

### New Capabilities

- `model-preview`: presenting the language server's rendered representations of a
  ZDL or ZFL document beside the editor, keeping them in step with the text, and
  rendering their diagrams locally.

  *Named for what it shows, not for a format. An earlier name,
  `markdown-preview`, described the one thing this capability deliberately is
  not: it neither uses VS Code's Markdown preview nor asks the user to think
  about Markdown. Markdown is one of the formats a representation may arrive in.*

### Modified Capabilities

None.

## Impact

- **Depends on `003-lsp-client`.** Preview content has no other source.
- **Depends on a new server request** returning representations for a document.
  IntelliJ builds these in-process — `ZdlToMarkdownPlugin.generatePlantUML` for
  ZDL, `GenerateMermaidFromZfl` for ZFL. Contract proposed in `zenwave-specs`.
- **Implies upstream work on ZDL diagrams.** IntelliJ's ZDL preview emits
  PlantUML; this project chose Mermaid, for reasons recorded in
  `openspec/project.md`. The server has to be able to emit Mermaid for ZDL, which
  means porting those templates upstream — where both IDEs benefit — rather than
  here.
- **A bundled Mermaid library** in `packages/extension`, adding meaningfully to
  the VSIX size.
- **A claim on the ZDL and ZFL file types.** A custom editor registration means
  VS Code offers a second way to open a model file, and lets the user make it the
  default through editor associations. It is registered as an option, never as
  the default, so opening a model keeps showing the model.
- **`packages/preview-renderer` loses its reason to exist** in its current form.
  It was scaffolded to hold a ported Handlebars renderer; with rendering upstream,
  what remains on this side is a webview. Resolve it during implementation rather
  than leaving an empty package.
- **Supersedes `zdl-vscode`'s preview.** Users migrating will notice the tabs and
  the Mermaid diagrams; they should not notice anything missing.
