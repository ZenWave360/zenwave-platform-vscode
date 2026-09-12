# 001 — Tasks

## Repository foundation
- [x] `git init` and monorepo root: npm workspaces, shared `tsconfig.base.json`,
      `.gitignore`, `.editorconfig`, MIT `LICENSE`
- [x] `openspec/` convention (`README.md`) and project context (`project.md`)
- [x] This change: proposal, design, delta specs, tasks
- [x] Root `README.md` explaining the project and how to work on it
- [x] `docs/architecture.md` — the dual-host picture and upstream dependencies
- [x] `AGENTS.md` / `CLAUDE.md` pointing contributors and agents at the workflow

## Extension package
- [x] `packages/extension/package.json` with identity `ZenWave360.zenwave-platform`,
      both `main` and `browser` entries
- [x] `tsconfig.json` extending the base
      *(dropped project references: `composite` fights `--noEmit`, and esbuild
      does the building, so `tsc` is typecheck-only per workspace)*
- [x] esbuild script building `dist/node` and `dist/browser`, with watch mode
- [x] `.vscodeignore` so the published VSIX carries only `dist`, `syntaxes`,
      `resources` and metadata
- [x] ESLint rule forbidding Node API imports outside `src/node/`, so the host
      boundary is enforced rather than merely documented
- [x] `.vscode/launch.json` with desktop and web extension-host configurations

## Host capabilities
- [x] `HostCapabilities` interface and the shared `activate(context, capabilities)`
- [x] Node entry constructing desktop capabilities
- [x] Browser entry constructing web capabilities
- [x] Publish `zenwave.canRunSdk` and `zenwave.canUseTerminal` context keys
- [x] ZenWave output channel; log detected capabilities at activation
- [x] A `zenwave.showOutput` command so users can reach the channel

## Languages
- [x] Carry over `zdl.tmLanguage.json` and `zfl.tmLanguage.json`, then merge in
      the newer website/blog lineage — see `design.md`
- [x] Fix `\b(disabled)\b?` in `pluginsBlock`: a quantified zero-width assertion
      that Oniguruma rejects, which killed ZDL tokenization at `plugins {`
- [x] Replace `source.java#comments` with native comment rules in both grammars
      *(the delegation left ZFL doc comments unconsumed, so an apostrophe in
      prose opened a string that ate the rest of the file)*
- [x] Add to ZFL: `emits` keyword, `service System.Service` references, outcome
      labels, `@import(...)`
- [x] Make each plugin declaration a `begin`/`end` block so nested braces balance
      *(the first plugin's `}` was closing the whole `plugins { … }` block)*
- [x] Scope plugin names as `entity.name.type.zdl` (like entities) and `config` /
      plugin option keys as `variable.other.member.zdl` (like fields)
- [x] Copy `resources/` icons
- [x] Contribute `languages` and `grammars` in `package.json`
- [x] Give ZFL its own language configuration instead of sharing ZDL's
      *(`zdl-vscode` pointed both at one generic scaffolded file with no folding
      or indentation rules — an oversight, now split and filled in, with
      javadoc `onEnterRules` on ZDL only)*

## Verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run build` produces both bundles
- [x] Browser bundle confirmed free of Node APIs — its only `require` is `vscode`
- [x] Smoke-test fixtures: one `.zdl` and one `.zfl` under `fixtures/`
- [x] F5 launches the desktop extension; a `.zdl` file is highlighted
- [x] `npm run run-in-browser` launches `@vscode/test-web`; a `.zdl` file is
      highlighted and no Node API error appears in the console
- [x] Confirm SDK-gated commands are hidden in the web host
      *(nothing is gated yet — no gated command exists until `sdk-runner`)*

## Archive
- [x] Handled by `openspec archive 001-extension-foundation` — it validates,
      folds both delta specs into `openspec/specs/` and moves this folder into
      `openspec/archive/`. Was two manual steps before the CLI was adopted;
      leaving them as open tasks would make this change permanently 30/32, since
      they cannot be ticked before the archive that ticks them.
