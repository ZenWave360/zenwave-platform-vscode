# Brand assets for model files

## Why

The extension still packages legacy file and marketplace icons. The current
ZenWave brand set assigns distinct icons to ZDL, ZenWave SDK (`.zw`), and ZFL
files, so the extension needs to use those assets directly.

## What Changes

- Replace legacy extension and language icons with the supplied ZenWave assets.
- Register `.zw` separately as the ZenWave SDK language so it can display its
  required SDK icon while retaining ZDL syntax and features.
- Remove the replaced legacy icon files from the packaged extension.

## Impact

- Affected capability: `languages`
- Affected package: `packages/extension`
