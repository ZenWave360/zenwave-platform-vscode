## Purpose

Put the things the language server knows about a model — what a concept connects
to, what it belongs to, and how a flow's services ought to be arranged — within
reach of someone editing that model, as ordinary editor commands.

## ADDED Requirements

### Requirement: The user can follow what a concept connects to
The extension SHALL offer, for the concept under the cursor in a model document,
`zenwave.model.forwardReferences` to see what it references and
`zenwave.model.reverseReferences` to see what references it. Results
SHALL be navigable, and SHALL include matches in documents other than the one
being edited.

#### Scenario: What this command leads to
- **GIVEN** the cursor on a command declared in a ZFL flow
- **WHEN** the user asks what it references
- **THEN** the concepts it leads to are listed, and choosing one opens it where
  it is declared

#### Scenario: What uses this entity
- **GIVEN** the cursor on an entity declared in a ZDL model
- **WHEN** the user asks what references it
- **THEN** the places that use it are listed, including uses in other documents
  of the same architecture

#### Scenario: A single result
- **GIVEN** a concept with exactly one match
- **WHEN** the user follows it
- **THEN** they arrive at it directly, without being asked to choose from a list
  of one

#### Scenario: Nothing to show
- **GIVEN** a concept the server reports no references for
- **WHEN** the user asks
- **THEN** they are told there are none, rather than being shown an empty list
  with no explanation

#### Scenario: The cursor is not on a concept
- **GIVEN** the cursor in whitespace or in a comment
- **WHEN** the user invokes the command
- **THEN** nothing happens and nothing reports an error

### Requirement: The user can see which concepts a position belongs to
The extension SHALL report, through `zenwave.model.conceptsAt`, the architectural
concepts that the position in the document belongs to, where the server can
identify any.

#### Scenario: Locating yourself in an architecture
- **GIVEN** the cursor inside a service declaration in a large model
- **WHEN** the user asks which concepts this belongs to
- **THEN** the concepts covering that position are shown, named as the server
  identifies them

#### Scenario: A position that belongs to nothing identifiable
- **GIVEN** the cursor somewhere the server can identify no concept
- **WHEN** the user asks
- **THEN** they are told so, rather than shown an empty result

#### Scenario: A workspace with no architecture
- **GIVEN** a model opened with no architecture manifest resolved
- **WHEN** the user asks which concepts a position belongs to
- **THEN** they are told that this needs an architecture, and how to configure one

### Requirement: The user can organise a flow's services
The extension SHALL offer, for a ZFL document, `zenwave.zfl.organizeServices`,
which replaces its services with the arrangement the server produces. The replacement SHALL be a
single undoable edit, and SHALL leave the document untouched if it fails.

#### Scenario: Organising a flow
- **GIVEN** a `.zfl` document whose services are declared in the order they were
  written
- **WHEN** the user invokes the organise command
- **THEN** the document is rewritten with the server's arrangement

#### Scenario: Undoing it
- **GIVEN** a document that has just been organised
- **WHEN** the user undoes
- **THEN** the document returns to exactly what it was, in one step

#### Scenario: A document that cannot be organised
- **GIVEN** a ZFL document the server cannot process, such as one with a syntax
  error
- **WHEN** the user invokes the command
- **THEN** the document is left exactly as it was, and the user is told why

#### Scenario: Nothing to change
- **GIVEN** a document whose services are already arranged as the server would
  arrange them
- **WHEN** the user invokes the command
- **THEN** the document is not modified, and its undo history is not disturbed

#### Scenario: The command is offered where it applies
- **GIVEN** a `.zdl` file or a file that is not a model
- **WHEN** the user looks for the organise command
- **THEN** it is not offered

### Requirement: These commands are absent without a connected server
The extension SHALL NOT offer these commands when no language server is
connected, or when the connected server does not support the request behind
them, and SHALL say which of those is the case if one is invoked anyway.

#### Scenario: No server
- **GIVEN** a host with no language server
- **WHEN** the user looks for these commands
- **THEN** they are not offered

#### Scenario: A server that does not support one of them
- **GIVEN** a connected server that supports some ZenWave requests and not others
- **WHEN** the user looks for these commands
- **THEN** only those the server supports are offered

#### Scenario: Invoked anyway
- **GIVEN** a command invoked programmatically while the server is unavailable
- **WHEN** it runs
- **THEN** it changes nothing and reports that the feature needs the ZenWave
  language server
