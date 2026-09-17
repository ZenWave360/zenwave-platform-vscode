# Changelog

## [Unreleased]

### Added
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

## [0.1.0] - 2026-09-15

### Added
- ZDL and ZFL language support: file associations, TextMate grammars, and editor
  configuration for comments, brackets, folding and indentation.
- Dual extension host support — runs in both desktop VS Code and browser-based
  VS Code (vscode.dev, github.dev).
- Host capability detection, so features that cannot work in the current host are
  hidden rather than presented and broken. Detected capabilities are logged to
  the ZenWave output channel.
