# ZenWave brand assets

This folder contains the current logo and icon set. Use the files at the root
for new references. Earlier variants and copies are preserved in `bak/root`.

**For a `.zw` file, use `zenwave-sdk-icon.svg`** (or
`zenwave-sdk-icon.png` where PNG is required). It is the blue hexagon with a
terminal badge and is also the ZenWave SDK logo.

## Which file should I use?

| Purpose | File | Appearance and usage |
| --- | --- | --- |
| ZenWave SDK logo; `.zw` file icon | [`zenwave-sdk-icon.svg`](zenwave-sdk-icon.svg) | Blue hexagon with terminal. This SVG is the master. |
| PNG version of the SDK / `.zw` icon | [`zenwave-sdk-icon.png`](zenwave-sdk-icon.png) | Use when the consumer cannot use SVG. |
| `.zdl` file icon | [`zdl-file-icon.svg`](zdl-file-icon.svg) | Orange and teal hexagon without a terminal. This SVG is the master. |
| PNG version of the `.zdl` icon | [`zdl-file-icon.png`](zdl-file-icon.png) | Use when the consumer cannot use SVG. |
| ZenWave Platform logo; `.zfl` file icon | [`zenwave-logo.svg`](zenwave-logo.svg) | Orange and teal rounded wave mark. The same asset serves both purposes; its established filename is intentional. |
| VS Code Marketplace icon | [`zenwave-platform-icon.png`](zenwave-platform-icon.png) | Square PNG export of `zenwave-logo.svg`, required because VSIX marketplace icons cannot be SVG. |
| Navigation wordmark | [`zenwave-wordmark-nav.svg`](zenwave-wordmark-nav.svg) | Horizontal wordmark for navigation or other wide layouts. |
| ZDL website illustration | [`zdl-website-diagram-icon.png`](zdl-website-diagram-icon.png) | Colored hierarchy diagram for website content. This is distinct from the `.zdl` file icon. |
| ZFL website illustration | [`zfl-website-flow-icon.png`](zfl-website-flow-icon.png) | Colored flow diagram for website content. This is distinct from the `.zfl` file icon. |

Use the SVG master when possible. If a product requires a particular raster
size or square canvas, export it from the relevant SVG.
`zenwave-platform-icon.png` is the dedicated raster export of
`zenwave-logo.svg` for VS Code Marketplace packaging.

The `platform/icons` files in `bak/root` came from website assets; that folder
was not the VS Code extension's icon directory. The VS Code extension has its
own assets under `zenwave-platform-vscode/packages/extension/resources`. Its
existing `zdl-file-icon` is a blue hexagon, so using the orange and teal ZDL
icon there requires updating that consumer.

For old filenames and website route replacements, see
[`FILE-RENAME-REPORT.md`](FILE-RENAME-REPORT.md). For the duplicate analysis and
history of the variants, see [`LOGO-INVENTORY.md`](LOGO-INVENTORY.md).
