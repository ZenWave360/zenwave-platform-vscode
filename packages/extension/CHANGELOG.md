# Changelog

## [Unreleased]

### Added
- Run CodeLens actions for enabled ZenWave SDK plugin declarations in trusted
  desktop workspaces, with task-backed execution and configurable environment.
- SDK-backed plugin and option completion and hover help, with a shipped
  catalogue fallback for browser and unavailable-SDK authoring.

## [0.1.0] - 2026-09-15

### Added
- ZDL and ZFL language support: file associations, TextMate grammars, and editor
  configuration for comments, brackets, folding and indentation.
- Dual extension host support — runs in both desktop VS Code and browser-based
  VS Code (vscode.dev, github.dev).
- Host capability detection, so features that cannot work in the current host are
  hidden rather than presented and broken. Detected capabilities are logged to
  the ZenWave output channel.
