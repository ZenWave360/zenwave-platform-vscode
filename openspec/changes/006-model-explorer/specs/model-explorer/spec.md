## Purpose

Give the workspace's architecture and the model in front of the user a navigable
shape — two trees in their own place in the sidebar, built from what the language
server knows rather than from what a single file happens to say.

## ADDED Requirements

### Requirement: ZenWave has its own place in the sidebar
The extension SHALL contribute a ZenWave container to the activity bar, holding
an `Architecture` tree and a `Model` tree, reachable whether or not a model
document is open.

#### Scenario: Finding the trees
- **GIVEN** a workspace with ZenWave models
- **WHEN** the user looks at the activity bar
- **THEN** there is a ZenWave entry, and opening it shows the architecture and
  model trees

#### Scenario: A workspace with nothing ZenWave in it
- **GIVEN** a workspace containing no models and no architecture manifest
- **WHEN** the user opens the ZenWave container
- **THEN** each tree explains what is missing rather than showing an empty box

### Requirement: The workspace architecture is browsable without opening a file
The architecture tree SHALL present the workspace's architecture manifest as a
hierarchy, and SHALL populate as soon as the user opens it, without requiring
them to open a document first.

#### Scenario: Exploring an architecture before opening anything
- **GIVEN** a workspace whose architecture manifest declares domains and
  subdomains
- **WHEN** the user opens the ZenWave container with no editor open
- **THEN** the architecture tree shows those domains and their subdomains

#### Scenario: An architecture spread across repositories
- **GIVEN** a workspace whose architecture manifest lives in one repository and
  whose models live in others, opened as separate folders
- **WHEN** the user opens the architecture tree
- **THEN** it shows that workspace's one architecture, regardless of which folder
  the user last had open

#### Scenario: A workspace with no manifest
- **GIVEN** a workspace with model files but no architecture manifest
- **WHEN** the user looks at the architecture tree
- **THEN** it says no architecture manifest was found and points at how to
  configure one, rather than appearing broken

#### Scenario: The manifest is edited
- **GIVEN** the architecture tree showing a manifest's contents
- **WHEN** the user adds a domain to that manifest and saves it
- **THEN** the tree reflects the new domain

### Requirement: The model tree follows the document the user is looking at
The model tree SHALL show the conceptual hierarchy of the model document the user
is currently working on, SHALL name that document, and SHALL keep following the
user when they move to another model document — including when the document is
being shown as a preview or as a diagram rather than as text. It SHALL NOT change
what it is showing when the user moves to a document that is already part of the
hierarchy on screen.

#### Scenario: Opening a flow
- **GIVEN** a `.zfl` file the user opens
- **WHEN** the model tree is visible
- **THEN** it shows that flow's hierarchy, and names the document it is showing

#### Scenario: Moving to another model
- **GIVEN** the model tree showing `place-order.zfl`
- **WHEN** the user focuses an editor holding `cancel-order.zfl`
- **THEN** the tree shows `cancel-order.zfl`

#### Scenario: Looking at a diagram instead of text
- **GIVEN** a flow being shown as a diagram, with no text editor focused
- **WHEN** the model tree is visible
- **THEN** it shows that flow's hierarchy, exactly as it would for the text

**Rationale:** this is the scenario that rules out the standard Outline view.
With previews and diagrams as editors, the user is frequently not in a text
editor — and that is precisely when they are most likely to want the tree.

#### Scenario: Working on something that is not a model
- **GIVEN** the model tree showing a flow
- **WHEN** the user focuses an editor holding a Java file
- **THEN** the tree keeps showing the last model, rather than emptying

#### Scenario: Drilling into the hierarchy
- **GIVEN** the model tree showing a flow, whose systems are declared in a ZDL
  document the flow annotates
- **WHEN** the user selects one of those systems and the ZDL document opens
- **THEN** the tree still shows the flow, with that system in it

#### Scenario: Deliberately moving to another model
- **GIVEN** the model tree showing a flow
- **WHEN** the user opens a model document that is not part of that hierarchy
- **THEN** the tree shows the newly opened document

#### Scenario: A model that cannot be read
- **GIVEN** a model document with a syntax error and nothing shown yet
- **WHEN** the model tree is visible
- **THEN** it says the document could not be read

**Rationale:** the hierarchy spans documents by design — a flow's systems are
declared in the ZDL files it annotates. Navigating into one of those is drilling
into what the tree is showing, not leaving it, so retargeting there would make
the tree destroy its own context every time it was used. What counts as a change
of context is arriving somewhere the tree was not already describing.

### Requirement: The hierarchy reaches beyond the open document
The model tree SHALL present the hierarchy the language server derives, including
elements that are declared in other documents or inferred across the model, and
SHALL NOT be limited to what is written in the document being shown.

#### Scenario: Systems declared elsewhere
- **GIVEN** a ZFL flow that refers to a system whose services are declared in a
  ZDL file it annotates
- **WHEN** the model tree shows that flow
- **THEN** the system and its services appear, even though they are not written
  in the flow document

#### Scenario: Commands derived across flows
- **GIVEN** a ZFL document whose commands appear inside `when` blocks rather than
  under their service
- **WHEN** the model tree shows it
- **THEN** each command appears under the service that handles it

### Requirement: Selecting a node goes to what it stands for
Selecting a node SHALL reveal the source it comes from, in the right document and
at the right place. Where a node points at further resources, those SHALL be
reachable from it.

#### Scenario: Navigating to a declaration
- **GIVEN** the model tree showing a service
- **WHEN** the user selects it
- **THEN** the document that declares it is opened, scrolled to the declaration

#### Scenario: Navigating to another file
- **GIVEN** a node whose declaration lives in a different document from the one
  the tree is showing
- **WHEN** the user selects it
- **THEN** that other document is opened at the declaration

#### Scenario: Reaching a related resource
- **GIVEN** a node the server associates with other resources, such as the ZDL
  model a system is defined by
- **WHEN** the user asks for them on that node
- **THEN** those resources are offered and can be opened

#### Scenario: Following the cursor
- **GIVEN** the model tree open beside a model document
- **WHEN** the user moves the cursor into a declaration in the text
- **THEN** the corresponding node is revealed in the tree

### Requirement: The trees present what the server describes, in this client's vocabulary
The trees SHALL show a node under the name the server gives it, unless this
client has a better way to present that kind, SHALL choose icons and grouping
from the kind and the presentation hints, and SHALL show a node of a kind it does
not recognise rather than dropping it.

#### Scenario: A node kind the client has icons for
- **GIVEN** hierarchy nodes of several kinds — systems, services, commands,
  events
- **WHEN** the trees show them
- **THEN** each kind is visually distinguishable

#### Scenario: A node kind released after the extension
- **GIVEN** a server returning a node of a kind this extension does not know
- **WHEN** the tree shows it
- **THEN** the node still appears, under the name the server gave it and with a
  neutral icon, rather than being dropped

#### Scenario: A kind this client presents its own way
- **GIVEN** a kind for which this editor's conventions call for different wording
  from the name the server supplied
- **WHEN** the tree shows it
- **THEN** it reads the way a VS Code tree reads, rather than the way the server
  wrote it

**Rationale:** this is the opposite division from the view model in `004`, where
the server's titles bind. Here the name is a **usable default** — good enough to
show, never binding. An earlier wording said the client derives the label from
the kind, which contradicted every node carrying one and would have left an
unknown kind with nothing to show.

### Requirement: A tree selection is reflected in an open diagram
Where a diagram is open for the same document, selecting a node in the model tree
SHALL highlight the corresponding node in that diagram.

#### Scenario: Locating a command in the diagram
- **GIVEN** a flow open as a diagram, with the model tree beside it
- **WHEN** the user selects a command in the tree
- **THEN** the matching node is highlighted in the diagram

#### Scenario: Clearing the selection
- **GIVEN** a highlighted node in a diagram
- **WHEN** the user clears the selection in the tree
- **THEN** the highlight is removed

#### Scenario: No diagram open
- **GIVEN** the model tree with no diagram open for its document
- **WHEN** the user selects a node
- **THEN** the navigation still happens, and nothing reports an error

### Requirement: The trees explain themselves when they have nothing to show
Where a tree is empty, it SHALL say which of these is the case: no language
server available, the server does not support hierarchies, no manifest found, no
model document open, or the document could not be read. Where the user can act on
it, the tree SHALL offer the action.

#### Scenario: No language server
- **GIVEN** a host with no language server
- **WHEN** the user opens either tree
- **THEN** it states that the trees need the ZenWave language server

#### Scenario: Nothing open yet
- **GIVEN** a workspace with no model document open
- **WHEN** the user looks at the model tree
- **THEN** it invites them to open a model file

#### Scenario: Diagnosing an empty tree
- **GIVEN** a tree that is unexpectedly empty
- **WHEN** the user opens the ZenWave output channel
- **THEN** the reason is recorded there
