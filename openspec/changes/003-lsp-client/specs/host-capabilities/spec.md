## MODIFIED Requirements

### Requirement: The extension reports what the current host can do
The extension SHALL determine, at activation, whether the current host can run
external processes, use terminal-backed tasks, reach a local file system, and
which language server transport — if any — is usable here, and SHALL make that
determination available to feature code.

#### Scenario: Capabilities in the desktop host
- **GIVEN** the extension activating in the Node extension host
- **WHEN** capability detection completes
- **THEN** process execution, terminal tasks and local file system access are all
  reported as available, and the language server transport is reported as the
  child-process one

#### Scenario: Capabilities in the web host
- **GIVEN** the extension activating in the Web Worker extension host
- **WHEN** capability detection completes
- **THEN** process execution and terminal tasks are reported as unavailable, and
  the language server transport is reported as the worker-backed one or as none,
  according to whether a worker server is available in this build

#### Scenario: A user asking why language features are missing
- **GIVEN** a user who sees no diagnostics on an invalid model
- **WHEN** they open the ZenWave output channel
- **THEN** the reported language server transport tells them whether a server was
  expected here at all
