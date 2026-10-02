## Context

VS Code assigns a file icon to a language contribution, not to an individual
extension within that contribution. The existing `zdl` language owns both
`.zdl` and `.zw`, which prevents the required distinct icon treatment.

## Decision

Register `zw` as a second language contribution using the same language
configuration and TextMate grammar as ZDL. Treat `zw` wherever the extension
currently treats `zdl` as a model document, including the language client and
SDK authoring providers. This changes only the displayed language identity and
icon; both extensions continue to receive ZDL syntax and functionality.

The canonical PNG assets are used where a raster icon is already expected. The
ZFL icon uses the canonical platform SVG; the extension identity uses a square
PNG export of that SVG because VSIX marketplace icons cannot be SVG.

## Risks and trade-offs

The language id for `.zw` changes from `zdl` to `zw`. Supporting `zw` in every
ZDL-facing selector avoids feature loss and allows VS Code to show the required
SDK-specific icon.
