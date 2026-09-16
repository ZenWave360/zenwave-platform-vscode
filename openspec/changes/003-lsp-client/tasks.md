# 003 — Tasks

## 1. Upstream prerequisites

These are not this repo's work, but nothing below can be finished without them.
Track them here so the blocker is visible rather than discovered.

- [ ] 1.1 `zenwave-lsp`: `lsp-js` with real sources — it is the server in both
      hosts, so nothing here starts without it
      Still unavailable locally: the tracked module has its Gradle declaration
      and `.gitkeep` placeholders only; no implementation source exists. Producer work
      is queued in store `002-kmp-browser-support`, tasks 4.2/4.3.
- [ ] 1.2 Agree how `@zenwave360/lsp-js` is versioned against this extension, and
      whether it is bundled into the VSIX or a dependency
- [ ] 1.3 `zenwave-specs`: `002-kmp-browser-support` — the shared Kotlin
      libraries loading in a browser at all. One Node import at the bottom of the
      chain (ref-parser → manifest-core → manifest-graph → workspace-runtime →
      lsp-core → lsp-js) is what stops the web host today, and nothing done in
      `zenwave-lsp` fixes it
- [ ] 1.4 `zenwave-lsp`: browser transports for `lsp-js` —
      `BrowserMessageReader` / `BrowserMessageWriter` rather than the Node build
      of `vscode-languageserver`
- [ ] 1.5 `zenwave-specs`: `001-ide-client-contracts` — the custom-request
      contracts `004` and `005` depend on

## 2. Client scaffolding

- [ ] 2.1 Add `vscode-languageclient`; import `/node` only from `src/node/` and
      `/browser` only from `src/browser/`
- [ ] 2.2 Extend the ESLint host-boundary rule to cover the node sub-path, so the
      boundary is enforced rather than remembered
- [ ] 2.3 Extend `HostCapabilities.languageServer` to report the transport this
      host can actually use, and log it at activation
- [x] 2.4 A shared client supervisor taking a transport factory by injection:
      start, stop, restart, current state
      `src/lsp/supervisor.ts`, covered by lifecycle/concurrency/crash unit tests.
      Host activation integration remains open with the actual transports.

## 3. Transports

- [ ] 3.1 Desktop: run `@zenwave360/lsp-js` as a Node child process over IPC,
      honouring `zenwave.lsp.serverPath` when set
- [ ] 3.2 Browser: run the same module in a Web Worker
      *(blocked by the KMP browser work — until then report `none` and take the
      fallback)*
- [ ] 3.3 Report a failure to start once, with what went wrong — not one error
      per document
- [ ] 3.4 Both: document selectors for `zdl`, `zfl` **and the resolved manifest**,
      and a shared output channel
- [ ] 3.5 Select the manifest by its resolved URI, not by a `.yml` / `.yaml`
      glob — the module upstream claims those extensions broadly, and the
      workspace is full of unrelated YAML
- [ ] 3.6 Activation: a workspace carrying ZenWave configuration, and opening the
      manifest — not only `onLanguage:zdl` / `onLanguage:zfl`
- [ ] 3.7 Confirm a workspace with nothing ZenWave in it does not start the
      extension
- [ ] 3.8 Update `HostCapabilities.languageServer` from `'jvm' | 'worker'` to the
      transports that actually exist

## 4. Manifest resolution

- [ ] 4.1 `zenwave.workspace.manifest` setting, `resource`-scoped, naming the
      architecture manifest — authoritative when set
- [ ] 4.2 Otherwise look for `.zenwave/config.yml` at each workspace folder root
      and read its `project-manifest`, through `vscode.workspace.fs` so the web
      host can do it too
- [ ] 4.3 Resolve once per workspace, not per document — verify with a multi-root
      workspace whose folders have no common ancestor
- [ ] 4.4 Decide what to do when two workspace folders each carry a
      configuration: pick one and say which, rather than silently taking the
      first
- [ ] 4.5 Pass `{ zenwave: { configUri, projectManifestUri } }` as initialization
      options
- [ ] 4.6 Watch the resolved configuration and the manifest; notify the server on
      change
- [ ] 4.7 Start without a manifest when none is found, and say so in the log
- [ ] 4.8 Log which manifest was resolved and by which of the three routes
- [ ] 4.9 Audit the manifest-location handling for path assumptions — no
      separators, no drive letters, URI joining only, so the web host works
- [ ] 4.10 Confirm the extension never fetches model content and never chooses a
      source; resolution order belongs to the manifest
- [ ] 4.11 `zenwave.workspace.preferredSource` setting, unset by default, mapping
      to `ManifestLoadOptions.preferredSource` / `allowFallback`
- [ ] 4.12 Pinning a source the manifest does not declare reports it, rather than
      resolving to nothing
- [ ] 4.13 Upstream: `zenwave-lsp` has to carry load options through to
      `ZenWaveManifestLoader` — today it constructs it with defaults

## 5. Credentials

- [ ] 5.1 Answer the server's credential request: `vscode.authentication` for
      hosts the editor signs into, `SecretStorage` otherwise
- [ ] 5.2 Commands to record and to clear a stored credential
- [ ] 5.3 Non-secret configuration — url patterns, header name, type — as
      settings; never the secret
- [ ] 5.4 Match by origin — scheme, host and port compared as a whole, never a
      substring or an unanchored pattern. The upstream matcher defaults to `.*`
      and compares full strings, so neither its default nor a bare host name is
      usable as-is
- [ ] 5.5 Do not carry a credential across a redirect to another origin
- [ ] 5.6 Refuse anything that does not match, and log the refusal
- [ ] 5.7 Test the refusal with a manifest naming an unauthorised host — this is
      a security boundary, not a preference
- [ ] 5.8 Re-ask on rejection rather than caching a credential for the session
- [ ] 5.9 Declining leaves the content unreachable and the editor working
- [ ] 5.10 Gate the server, content resolution and credentials on workspace
      trust, and re-enable them when trust is granted without a reload
- [ ] 5.11 Update `untrustedWorkspaces` in `package.json` — it promises only that
      code generation is limited, which stops being true with this change

## 6. ZenWave requests

- [x] 6.1 A request helper returning a result that distinguishes *no server*,
      *unsupported*, *failed* and *ok*
- [x] 6.2 Read the server's advertised custom requests at initialisation and use
      them to answer *unsupported* without a round trip
      Both covered by `lsp-supervisor.test.ts` and shared smoke using injected
      test transports. Capability path verified against
      `zenwave-lsp/lsp-jvm/.../ZenwaveLspServer.kt:253–266`; real JS wire validation
      remains open (the JS server does not exist yet).
- [ ] 6.3 Typed wrappers for the requests that exist today
      (`zenwave/workspaceStatus` first — it is the cheapest end-to-end proof)

## 7. Diagnosability and control

- [ ] 7.1 Publish a context key for "a server is connected"
- [ ] 7.2 A status bar item showing ZenWave's state — connected, no server, or a
      host that offers less — that opens the detail when acted on
- [ ] 7.3 `zenwave.lsp.restart` command
- [ ] 7.4 Report an unexpected server exit, offering a restart
- [ ] 7.5 `zenwave.lsp.enabled`, `zenwave.lsp.serverPath`,
      `zenwave.lsp.trace.server`

## 8. Verification

- [ ] 8.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] 8.2 Browser bundle still free of Node APIs — check for `child_process`
      reaching it through `vscode-languageclient`
- [ ] 8.3 Desktop with a server: diagnostics and Go to Definition work on the
      fixtures
- [ ] 8.4 A deliberately broken server: the editor still works, the status bar
      says so, the output channel explains, and there is no notification storm
- [ ] 8.5 Kill the server process mid-edit: restart offered, editor responsive
- [ ] 8.6 A workspace mirroring `arcadia-editions` — one folder holding the
      architecture repository and the service repositories side by side —
      resolves one manifest and understands models in all of them
- [ ] 8.7 A browser host with only the architecture repository open: the ordered
      sources fall through to remote on their own, with no remote-only mode, and
      unreachable content reads as unresolved rather than broken
- [ ] 8.8 A browser host editing a flow in the opened repository: the diagram and
      the preview follow the unsaved buffer, not the published version — the
      scenario that fails if the buffer overlay is missing
- [ ] 8.9 A private repository in the browser: sign-in is offered and content
      resolves; declining leaves it unreachable without breaking the editor
- [ ] 8.10 Restricted Mode: no server starts, nothing is fetched, no credential
      is asked for, and the reason is legible
- [ ] 8.11 A service repository opened on its own with no manifest: highlighting
      and single-document features work, architecture views explain themselves
- [ ] 8.12 `npm run run-in-browser`: clean fallback, transport logged as `none`
- [ ] 8.13 `openspec validate 003-lsp-client --strict`

## 9. Archive

- [ ] 9.1 `openspec archive 003-lsp-client`
