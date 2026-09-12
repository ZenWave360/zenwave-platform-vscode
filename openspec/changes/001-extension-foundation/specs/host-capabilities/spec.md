# host-capabilities — delta for change 001

## ADDED Requirements

### Requirement: The extension activates in both desktop and web hosts
The extension SHALL activate successfully in the Node extension host and in the
Web Worker extension host, from the same published package.

#### Scenario: Opening a model file in desktop VS Code
- **GIVEN** VS Code running on a desktop machine
- **WHEN** the user opens a file with a `.zdl`, `.zw` or `.zfl` extension
- **THEN** the extension activates without error

#### Scenario: Opening a model file in vscode.dev
- **GIVEN** the extension installed in a browser-based VS Code such as vscode.dev
- **WHEN** the user opens a file with a `.zdl`, `.zw` or `.zfl` extension
- **THEN** the extension activates without error, and no functionality that
  depends on a Node API is loaded

### Requirement: The extension reports what the current host can do
The extension SHALL determine, at activation, whether the current host can run
external processes, use terminal-backed tasks, and reach a local file system,
and SHALL make that determination available to feature code.

#### Scenario: Capabilities in the desktop host
- **GIVEN** the extension activating in the Node extension host
- **WHEN** capability detection completes
- **THEN** process execution, terminal tasks and local file system access are all
  reported as available

#### Scenario: Capabilities in the web host
- **GIVEN** the extension activating in the Web Worker extension host
- **WHEN** capability detection completes
- **THEN** process execution and terminal tasks are reported as unavailable

### Requirement: Unavailable features are hidden, not broken
The extension SHALL NOT present commands, menu items or code lenses for features
that cannot function in the current host. Feature availability SHALL be published
as context keys usable in `when` clauses, and SHALL additionally be enforced when
a command executes.

#### Scenario: SDK actions in the web host
- **GIVEN** the extension running in a browser-based VS Code
- **WHEN** the user opens the command palette and types "ZenWave"
- **THEN** commands that require running the `zenwave-sdk` CLI are not listed

#### Scenario: A gated command invoked directly
- **GIVEN** a host where process execution is unavailable
- **WHEN** a command requiring process execution is invoked programmatically,
  bypassing the menu
- **THEN** the command does nothing destructive and reports that the feature is
  unavailable in this host

**Rationale:** in the browser, `zenwave-sdk` is not temporarily unavailable — it
is permanently unavailable, because it is JVM-only and launched via JBang. A
control that can never succeed misleads the user about whether the extension is
working.

### Requirement: Host capability reporting is diagnosable
The extension SHALL record the detected host capabilities to its output channel
at activation.

#### Scenario: A user reports a missing feature
- **GIVEN** a user who cannot find an expected ZenWave command
- **WHEN** they open the ZenWave output channel
- **THEN** they can see which capabilities were detected and therefore why the
  feature is absent
