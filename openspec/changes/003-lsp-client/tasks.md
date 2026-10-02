# 003 — Tasks

## 1. Upstream prerequisites

These are not this repo's work, but nothing below can be finished without them.
Track them here so the blocker is visible rather than discovered.

- [x] 1.1 `zenwave-lsp`: `lsp-js` with real sources — it is the server in both
      hosts, so nothing here starts without it
      Available locally: `@zenwave360/lsp-js` 0.1.0-SNAPSHOT built from zenwave-lsp
      `vscode-platform/lsp-hierarchy` d7156e7 (`lsp-js/build/npm-package`), consumed by the build
      and exercised by both smoke hosts (`test/smoke.ts` `realLanguageServer`). Not published.
- [ ] 1.2 Agree how `@zenwave360/lsp-js` is versioned against this extension, and
      whether it is bundled into the VSIX or a dependency
      Decision recorded in design.md §Decision (task 1.2), pending review: bundled into
      `dist/server`, pinned exactly in `package.json` `zenwaveLanguageServer`, not an npm dependency.
- [x] 1.3 `zenwave-specs`: `002-kmp-browser-support` — the shared Kotlin
      libraries loading in a browser at all. One Node import at the bottom of the
      chain (ref-parser → architecture-manifest → architecture-graph → workspace-runtime →
      lsp-core → lsp-js) is what stops the web host today, and nothing done in
      `zenwave-lsp` fixes it
      What this repo needs loads: the worker bundle (ref-parser, architecture-manifest, lsp-core, dsl-kotlin)
      starts in the `@vscode/test-web` extension host and answers diagnostics, hover and all seven
      `zenwave/*` requests (`npm run test:browser`). Caveat: lsp-core at d7156e7 does not use
      workspace-runtime, so that link of the chain is not exercised (store 002 3.1 remains open).
- [x] 1.4 `zenwave-lsp`: browser transports for `lsp-js` —
      `BrowserMessageReader` / `BrowserMessageWriter` rather than the Node build
      of `vscode-languageserver`
      `@zenwave360/lsp-js/worker` speaks to `vscode-languageclient/browser` over a Worker in the
      browser smoke test.
- [x] 1.5 `zenwave-specs`: `001-ide-client-contracts` — the custom-request
      contracts `004` and `005` depend on
      Available: store 001 tasks 2.1–2.8 done (zenwave-lsp d7156e7); `zenwave/eventFlowViews` and
      `zenwave/preview` answer over IPC and in the Worker (`test/smoke.ts`). Their review (store 1.1)
      is still pending.

## 2. Client scaffolding

- [x] 2.1 Add `vscode-languageclient`; import `/node` only from `src/node/` and
      `/browser` only from `src/browser/`
      `vscode-languageclient` 9.0.1 (LSP 3.17, VS Code ^1.82); `src/node/language-server.ts`,
      `src/browser/language-server.ts`; shared code imports types only.
- [x] 2.2 Extend the ESLint host-boundary rule to cover the node sub-path, so the
      boundary is enforced rather than remembered
      `.eslintrc.json` `@typescript-eslint/no-restricted-imports`; enforced by
      `lsp-client-status.test.ts` "ESLint enforces which host may import which vscode-languageclient entry".
- [x] 2.3 Extend `HostCapabilities.languageServer` to report the transport this
      host can actually use, and log it at activation
      `ipc` | `worker` | `none`, decided by each entry point from whether its server is present;
      logged at activation (checked in the desktop runner's output-channel assertions).
- [x] 2.4 A shared client supervisor taking a transport factory by injection:
      start, stop, restart, current state
      `src/lsp/supervisor.ts`, covered by lifecycle/concurrency/crash unit tests.
      Integrated with both real transports in `src/lsp/feature.ts`.

## 3. Transports

- [x] 3.1 Desktop: run `@zenwave360/lsp-js` as a Node child process over IPC,
      honouring `zenwave.lsp.serverPath` when set
      `NodeLanguageServerHost` (`TransportKind.ipc`); desktop smoke connects to the shipped server and
      fails with the reason for a `serverPath` that is not a file.
- [x] 3.2 Browser: run the same module in a Web Worker
      `WorkerLanguageServerHost`; browser smoke connects through a Worker.
- [x] 3.3 Report a failure to start once, with what went wrong — not one error
      per document
      The language client shows no notifications of its own (`QuietLanguageClient`); the supervisor
      records one failure with its reason (unit test "startup failure cleans up once", desktop smoke
      `serverPath` failure). A notification count is not asserted (8.4).
- [x] 3.4 Both: document selectors for `zdl`, `zfl` **and the resolved manifest**,
      and a shared output channel
      `documentSelector` in `src/lsp/manifest.ts`; the client logs and traces to the ZenWave channel.
      Smoke: server hover on the resolved manifest in both hosts.
- [x] 3.5 Select the manifest by its resolved URI, not by a `.yml` / `.yaml`
      glob — the module upstream claims those extensions broadly, and the
      workspace is full of unrelated YAML
      Filter `{ scheme, pattern: fsPath }`; smoke asserts no server hover on the fixture OpenAPI YAML.
      Sending that file would wedge today's server (store 001 task 2.17).
- [ ] 3.6 Activation: a workspace carrying ZenWave configuration, and opening the
      manifest — not only `onLanguage:zdl` / `onLanguage:zfl`
      Done for `.zenwave/config.yml` (`workspaceContains:.zenwave/config.yml`), which also covers opening
      the manifest it names. Open: a manifest named only by `zenwave.workspace.manifest` cannot activate
      the extension — VS Code has no activation event for a setting, and `onLanguage:yaml` would start it
      in every workspace with YAML (3.7). Spec question in the client-003 handoff.
- [x] 3.7 Confirm a workspace with nothing ZenWave in it does not start the
      extension
      Activation events are exactly `onLanguage:zdl`, `onLanguage:zfl`,
      `workspaceContains:.zenwave/config.yml` (unit test "the extension starts only for ZenWave
      workspaces and documents").
- [x] 3.8 Update `HostCapabilities.languageServer` from `'jvm' | 'worker'` to the
      transports that actually exist

## 4. Manifest resolution

- [x] 4.1 `zenwave.workspace.manifest` setting, `resource`-scoped, naming the
      architecture manifest — authoritative when set
      Desktop smoke: setting a manifest re-initialises the server with it and it is served.
- [x] 4.2 Otherwise look for `.zenwave/config.yml` at each workspace folder root
      and read its `project-manifest`, through `vscode.workspace.fs` so the web
      host can do it too
      Both smoke hosts resolve the fixture's `.zenwave/config.yml`.
- [x] 4.3 Resolve once per workspace, not per document — verify with a multi-root
      workspace whose folders have no common ancestor
      `manifest-resolution.test.ts` "multi-root folders without a common ancestor resolve once".
- [ ] 4.4 Decide what to do when two workspace folders each carry a
      configuration: pick one and say which, rather than silently taking the
      first
      Implemented and logged; decision recorded in design.md §Decision (task 4.4), pending review.
- [x] 4.5 Pass `{ zenwave: { configUri, projectManifestUri } }` as initialization
      options
      Plus `clientCapabilities.credentialRequest` (store decision 1.4). Unit test on the shape.
- [x] 4.6 Watch the resolved configuration and the manifest; notify the server on
      change
      Client side: a changed resolution restarts the server with new options (desktop smoke); a changed
      configuration or manifest file is forwarded as `workspace/didChangeWatchedFiles` (desktop runner
      checks the trace). The server does not take either up yet: store 001 task 2.9.
- [x] 4.7 Start without a manifest when none is found, and say so in the log
- [x] 4.8 Log which manifest was resolved and by which of the three routes
      `describeManifest`; desktop runner checks the output channel.
- [x] 4.9 Audit the manifest-location handling for path assumptions — no
      separators, no drive letters, URI joining only, so the web host works
      `src/lsp/manifest.ts` joins with `Uri.joinPath`; separators and drive letters are only
      classified in setting input (`manifest-resolution.ts`). Web smoke resolves `vscode-test-web:` URIs.
- [x] 4.10 Confirm the extension never fetches model content and never chooses a
      source; resolution order belongs to the manifest
      The client reads only `.zenwave/config.yml` and stats the manifest; no `fetch` in `src/`.
- [ ] 4.11 `zenwave.workspace.preferredSource` setting, unset by default, mapping
      to `ManifestLoadOptions.preferredSource` / `allowFallback`
      Blocked on zenwave-lsp store 001 2.14: no wire shape carries load options, so no setting ships.
- [ ] 4.12 Pinning a source the manifest does not declare reports it, rather than
      resolving to nothing
      Blocked on zenwave-lsp store 001 2.14 (requirement added to the store).
- [ ] 4.13 Upstream: `zenwave-lsp` has to carry load options through to
      `ZenWaveManifestLoader` — today it constructs it with defaults
      Filed: store 001 task 2.14 with evidence and the new requirement.

## 5. Credentials

- [ ] 5.1 Answer the server's credential request: `vscode.authentication` for
      hosts the editor signs into, `SecretStorage` otherwise
      Handler implemented (`src/lsp/credentials.ts`, decision 1.4 shape). Blocked on zenwave-lsp
      001 2.12/2.13: no server sends the request.
- [x] 5.2 Commands to record and to clear a stored credential
      `zenwave.credentials.record`, `zenwave.credentials.clear`. Interactive flows not automated.
- [x] 5.3 Non-secret configuration — url patterns, header name, type — as
      settings; never the secret
      `zenwave.credentials.origins`, application-scoped (unit test checks the scope).
- [x] 5.4 Match by origin — scheme, host and port compared as a whole, never a
      substring or an unanchored pattern. The upstream matcher defaults to `.*`
      and compares full strings, so neither its default nor a bare host name is
      usable as-is
      `credential-policy.test.ts` (lookalike hosts, ports, schemes, user information).
- [ ] 5.5 Do not carry a credential across a redirect to another origin
      Client refuses a request whose URL origin differs from the stated origin (unit test). The
      redirect itself happens in the server's fetch: blocked on zenwave-lsp 001 2.12/2.13.
- [x] 5.6 Refuse anything that does not match, and log the refusal
      Unit tests; both smoke hosts refuse an unauthorised origin; desktop runner checks the log line.
- [ ] 5.7 Test the refusal with a manifest naming an unauthorised host — this is
      a security boundary, not a preference
      The handler's refusal is tested; a manifest-driven request needs a server that asks.
      Blocked on zenwave-lsp 001 2.12/2.13.
- [ ] 5.8 Re-ask on rejection rather than caching a credential for the session
      Implemented (`attempt: "rejected"` forces a new GitHub session; a rejected stored secret is not
      offered again). Blocked on zenwave-lsp 001 2.12/2.13 for the wire.
- [ ] 5.9 Declining leaves the content unreachable and the editor working
      Client answers `null`. Blocked on zenwave-lsp 001 2.12/2.13.
- [x] 5.10 Gate the server, content resolution and credentials on workspace
      trust, and re-enable them when trust is granted without a reload
      `feature.ts` starts nothing untrusted and starts on `onDidGrantWorkspaceTrust`; the credential
      handler refuses untrusted. Restricted Mode behaviour is checked by hand (8.10).
- [x] 5.11 Update `untrustedWorkspaces` in `package.json` — it promises only that
      code generation is limited, which stops being true with this change
      New description plus `restrictedConfigurations` (unit test).

## 6. ZenWave requests

- [x] 6.1 A request helper returning a result that distinguishes *no server*,
      *unsupported*, *failed* and *ok*
- [x] 6.2 Read the server's advertised custom requests at initialisation and use
      them to answer *unsupported* without a round trip
      Both covered by `lsp-supervisor.test.ts` and shared smoke. Over the real wire in both hosts:
      `zenwave/workspaceStatus` (not advertised) answers `unsupported`; `-32601` also maps to it.
- [x] 6.3 Typed wrappers for the requests that exist today
      (`zenwave/workspaceStatus` first — it is the cheapest end-to-end proof)
      `src/lsp/requests.ts` `ZenwaveRequests`: hierarchy, forwardReferences, reverseReferences,
      organizeZflServices, eventFlowViews, preview, symbolAt, with `documentFailure` for -32803
      `data.kind`. `zenwave/workspaceStatus` does not exist in zenwave-lsp. Unit tests against the recorded
      wire samples; both smoke hosts call all seven.

## 7. Diagnosability and control

- [x] 7.1 Publish a context key for "a server is connected"
      `zenwave.languageServerAvailable`, plus `zenwave.languageServerRequests` and
      `zenwave.manifestAvailable`.
- [x] 7.2 A status bar item showing ZenWave's state — connected, no server, or a
      host that offers less — that opens the detail when acted on
      Shown for ZDL, ZFL and the manifest; `zenwave.lsp.showStatus`. Wording unit-tested.
- [x] 7.3 `zenwave.lsp.restart` command
      Smoke in both hosts.
- [x] 7.4 Report an unexpected server exit, offering a restart
      One warning with Restart / Show Output per exit after a connection; killing a server is checked
      by hand (8.5).
- [x] 7.5 `zenwave.lsp.enabled`, `zenwave.lsp.serverPath`,
      `zenwave.lsp.trace.server`
      Desktop smoke toggles each; the runner checks the protocol trace in the output channel.

## 8. Verification

- [x] 8.1 `npm run typecheck`, `npm run lint`, `npm run build`
- [x] 8.2 Browser bundle still free of Node APIs — check for `child_process`
      reaching it through `vscode-languageclient`
      The browser build rejects Node built-ins (`esbuild.mjs`); `dist/browser/extension.js` has no
      `child_process`; the ESLint boundary test covers the sub-paths.
- [x] 8.3 Desktop with a server: diagnostics and Go to Definition work on the
      fixtures
      Desktop smoke: diagnostic on `fixtures/lsp/broken.zdl`, Go to Definition in `fixtures/lsp/orders.zdl`.
- [ ] 8.4 A deliberately broken server: the editor still works, the status bar
      says so, the output channel explains, and there is no notification storm
      Automated part: a `serverPath` that is not a file fails once with its reason and the editor keeps
      the document. The status bar and the absence of notifications need a human.
- [ ] 8.5 Kill the server process mid-edit: restart offered, editor responsive
      Needs a human.
- [ ] 8.6 A workspace mirroring `arcadia-editions` — one folder holding the
      architecture repository and the service repositories side by side —
      resolves one manifest and understands models in all of them
      Needs a human; the server does not use the manifest for resolution yet.
- [ ] 8.7 A browser host with only the architecture repository open: the ordered
      sources fall through to remote on their own, with no remote-only mode, and
      unreachable content reads as unresolved rather than broken
      Needs a human; depends on server content resolution (store 001 2.11).
- [ ] 8.8 A browser host editing a flow in the opened repository: the diagram and
      the preview follow the unsaved buffer, not the published version — the
      scenario that fails if the buffer overlay is missing
      Needs 004/005 and store 001 2.11.
- [ ] 8.9 A private repository in the browser: sign-in is offered and content
      resolves; declining leaves it unreachable without breaking the editor
      Blocked on zenwave-lsp 001 2.12/2.13, then a human.
- [ ] 8.10 Restricted Mode: no server starts, nothing is fetched, no credential
      is asked for, and the reason is legible
      Needs a human.
- [ ] 8.11 A service repository opened on its own with no manifest: highlighting
      and single-document features work, architecture views explain themselves
      Needs a human.
- [ ] 8.12 `npm run run-in-browser`: clean fallback, transport logged as `none`
      With the worker bundle present the browser host now connects (`worker`). The `none` fallback
      applies to a build without it and is covered by unit tests of the status; a manual
      `run-in-browser` check remains.
- [x] 8.13 `openspec validate 003-lsp-client --strict`

## 9. Archive

- [ ] 9.1 `openspec archive 003-lsp-client`
