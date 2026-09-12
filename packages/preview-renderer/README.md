# @zenwave360/preview-renderer — placeholder

Renders ZDL/ZFL models to Markdown with embedded Mermaid diagrams.

Not implemented yet. Planned for the `markdown-preview` change:

- Port the Handlebars renderer from `zdl-vscode/src/web/preview/`
- Put it behind a `PreviewProvider` interface so an LSP-backed provider can
  replace it once `lsp-core` grows a `zenwave/preview` capability
- Emit Mermaid rather than PlantUML — see `docs/architecture.md`

Do not add code here without a change proposal in `openspec/changes/`.
