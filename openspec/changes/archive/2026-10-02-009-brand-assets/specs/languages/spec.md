## MODIFIED Requirements

### Requirement: ZDL and ZFL files are recognised by extension
The extension SHALL register a `zdl` language for `.zdl` files, a `zw` language
for `.zw` ZenWave SDK files, and a `zfl` language for `.zfl` files. Each
language SHALL have its designated current ZenWave file icon, and `.zw` files
SHALL retain ZDL syntax and SDK authoring support.

#### Scenario: Opening a ZDL file
- **GIVEN** a file named `customer.zdl`
- **WHEN** the user opens it
- **THEN** the editor reports the language as ZDL, and the file shows the
  orange-and-teal ZDL icon in the explorer

#### Scenario: Opening a ZenWave SDK file
- **GIVEN** a file named `generate.zw`
- **WHEN** the user opens it
- **THEN** the editor reports the language as ZenWave SDK, shows the blue SDK
  icon in the explorer, and provides ZDL syntax and SDK authoring support

#### Scenario: Opening a ZFL file
- **GIVEN** a file named `place-order.zfl`
- **WHEN** the user opens it
- **THEN** the editor reports the language as ZFL and shows the ZenWave Platform
  icon in the explorer
