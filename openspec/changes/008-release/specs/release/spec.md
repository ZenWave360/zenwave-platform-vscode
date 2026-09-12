## Purpose

Describe how a commit becomes an extension somebody can install — what the
package contains, how its version identifies it, which registries carry it, and
what is checked before any of that is irreversible.

## ADDED Requirements

### Requirement: The extension is installable from both registries
The extension SHALL be published to the VS Code Marketplace and to Open VSX, from
the same build, under the same version.

#### Scenario: Installing in VS Code
- **GIVEN** a user of Microsoft's VS Code
- **WHEN** they search the marketplace for ZenWave
- **THEN** the extension is offered and installs

#### Scenario: Installing in an editor that cannot reach the marketplace
- **GIVEN** a user of VSCodium, Cursor, Gitpod or another editor served by
  Open VSX
- **WHEN** they search their registry for ZenWave
- **THEN** the same version is offered and installs

#### Scenario: One registry refuses a publish
- **GIVEN** a release where publishing to one registry fails
- **WHEN** the release finishes
- **THEN** it is reported as failed rather than as successful, and it is
  recorded which registry carries that version and which does not

**Note:** a published version cannot be withdrawn, only superseded, so a partial
release cannot be undone. What this requires is that it is never reported as a
success, and that the gap is known — the remedy is a follow-up version, and
someone has to know to cut one.

### Requirement: A release is produced by CI from a tagged commit
Releases SHALL be built and published by the project's automation, from a commit
that carries a release tag, and SHALL NOT depend on a contributor's machine.

#### Scenario: Cutting a release
- **GIVEN** a maintainer who tags a commit for release
- **WHEN** the automation runs
- **THEN** the extension is built, verified and published without anyone
  packaging it locally

#### Scenario: An ordinary commit
- **GIVEN** a commit pushed without a release tag
- **WHEN** the automation runs
- **THEN** the extension is built and verified, and nothing is published

#### Scenario: Verification fails
- **GIVEN** a tagged commit whose build or checks fail
- **WHEN** the automation runs
- **THEN** nothing is published

### Requirement: A published version identifies what it was built from
Every published version SHALL be traceable to the exact commit it was built from,
and SHALL carry a record of what changed in it.

#### Scenario: Diagnosing a report
- **GIVEN** a user reporting a problem with a specific installed version
- **WHEN** a maintainer looks that version up
- **THEN** they can identify the commit it was built from

#### Scenario: Reading what changed
- **GIVEN** a user looking at the extension's listing before upgrading
- **WHEN** they read its release notes
- **THEN** they see what changed in that version

#### Scenario: Two builds of one commit
- **GIVEN** the same tagged commit built twice
- **WHEN** the two packages are compared
- **THEN** they contain the same set of files, and each file that is not a build
  timestamp or signature has the same content

### Requirement: Willing users can get a version before everyone does
The extension SHALL offer a pre-release channel, distinguishable from the stable
one, so that work whose dependencies are still moving can be exercised by users
who opt in.

#### Scenario: Opting in
- **GIVEN** a user who wants to try unreleased work
- **WHEN** they switch the extension to its pre-release version
- **THEN** they receive it, and can go back to the stable one

#### Scenario: Not opting in
- **GIVEN** a user who has done nothing
- **WHEN** a pre-release is published
- **THEN** they are not moved onto it

#### Scenario: Telling them apart
- **GIVEN** a user looking at which version they have
- **WHEN** they compare it to what is published
- **THEN** it is evident whether they are on a pre-release

### Requirement: The package contains what it should and nothing else
The published package SHALL contain everything the extension needs to run in both
hosts, and SHALL NOT contain sources, tests, fixtures, development configuration
or build intermediates.

#### Scenario: Running from the published package
- **GIVEN** the extension installed from a registry
- **WHEN** a user opens a ZDL file
- **THEN** it activates, is highlighted, and its icons are shown

#### Scenario: Weight
- **GIVEN** a published package
- **WHEN** its contents are listed
- **THEN** it carries no source, no test, no fixture and no development
  configuration

#### Scenario: A new asset
- **GIVEN** a change that adds an asset the extension needs at runtime, such as a
  bundled renderer
- **WHEN** that asset is removed from the build and a release is attempted
- **THEN** the release fails

### Requirement: What is published has been exercised in both hosts
Before a version is published, it SHALL be verified to activate and work in the
desktop host and in the browser host.

#### Scenario: A desktop regression
- **GIVEN** a change that breaks activation on the desktop
- **WHEN** the release automation runs
- **THEN** it fails before publishing

#### Scenario: A browser regression
- **GIVEN** a change that reaches a Node API from code the browser bundle loads
- **WHEN** the release automation runs
- **THEN** it fails before publishing, rather than reaching users of vscode.dev

**Rationale:** the browser failure mode is the one this project has warned about
from the start — it does not break a build, it breaks inside a Web Worker at a
user's keyboard. A release is the last place it can still be caught cheaply.
