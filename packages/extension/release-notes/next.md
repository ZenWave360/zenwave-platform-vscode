### Added
- A ZenWave container in the activity bar with an Architecture tree (the domains and
  subdomains of the workspace's architecture manifest) and a Model tree (the model
  in front of you), built from what the language server knows; each says what is
  missing when it has nothing to show.
- An EventFlow diagram for ZFL flows, from the ZenWave icon in a flow's editor title
  bar, beside the text or in its place: it follows edits as you type, switches
  between the flow and service views and humanized labels (`zenwave.eventflow.defaultView`,
  `zenwave.eventflow.humanizeLabels`), and says why when it has nothing to draw.
- `.zw` files are their own language, and the extension uses the ZenWave brand icons.
- Duplicate plugin declarations of the same type each have their own Run CodeLens and run independently.
- Run CodeLens actions for enabled ZenWave SDK plugin declarations in trusted
  desktop workspaces, with task-backed execution and configurable environment.
- Plugin and option completion and hover help from a ZenWave SDK plugin
  catalogue shipped with the extension, on desktop and in the browser.
- The ZenWave language server (`@zenwave360/lsp-js`) shipped with the extension:
  a Node child process on the desktop, a Web Worker in the browser, for ZDL, ZFL
  and the architecture manifest resolved from `zenwave.workspace.manifest` or
  `.zenwave/config.yml`. Status bar indication, restart command, `zenwave.lsp.*`
  settings, and credential commands for content the server may ask for.
- Restricted Mode now also holds back the language server, content resolution
  and credentials; trusting the workspace enables them without a reload.
- ZenWave: Go to What This References / Go to What References This, from the
  editor context menu and the palette, and ZenWave: Organize ZFL Services as one
  undoable edit. Offered only while a language server supporting them is connected.
- A read-only preview of ZDL, ZW and ZFL models (a ZW file shows its plugin
  configuration, resolved), from the editor title bar's ZenWave
  menu, the palette (**ZenWave: Open Preview**, **Open Preview to the Side**) and
  `Ctrl+Shift+V` / `Ctrl+K V`. It draws the language server's Mermaid diagrams with
  a renderer shipped in the extension, offers a diagram selector and, for ZFL, a
  render mode, follows edits and the colour theme, and explains why it has nothing
  to show. The menu is now also offered for `.zdl` files and is hidden in diff editors.
