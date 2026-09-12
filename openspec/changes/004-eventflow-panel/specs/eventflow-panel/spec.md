## Purpose

Show a ZFL flow as the diagram it describes, inside VS Code, using the same
EventFlow renderer the IntelliJ plugin embeds — and relay data and controls
between the editor and that renderer without interpreting the model.

## ADDED Requirements

### Requirement: A ZFL file can be opened as a flow diagram
The extension SHALL offer to view a ZFL document as a diagram, both beside its
text and in place of it, through `zenwave.eventflow.openToSide` and
`zenwave.eventflow.open`, and SHALL leave the text editor as what a ZFL file
opens as by default.

#### Scenario: Opening the diagram beside the text
- **GIVEN** a `.zfl` file open in the editor
- **WHEN** the user invokes the ZenWave EventFlow action
- **THEN** the diagram opens in the column beside the text, and the cursor stays
  in the text

#### Scenario: Replacing the text with the diagram
- **GIVEN** a `.zfl` file open as text
- **WHEN** the user asks to view it as a diagram in place
- **THEN** the diagram is shown in that same editor, in the same position among
  the tabs

#### Scenario: Going back to the text
- **GIVEN** a `.zfl` file being shown as a diagram
- **WHEN** the user asks to edit it again
- **THEN** the text is shown in that same editor

#### Scenario: Opening a flow file normally
- **GIVEN** a user who has never configured anything
- **WHEN** they open a `.zfl` file from the explorer
- **THEN** they get the text editor, not the diagram

#### Scenario: The action is offered only where it means something
- **GIVEN** a `.zdl` file or a plain text file in the active editor
- **WHEN** the user looks for the EventFlow action
- **THEN** it is not offered for that file

#### Scenario: Finding the ways to view a flow
- **GIVEN** a ZFL document, which can be shown as text, as a preview, or as a
  diagram
- **WHEN** the user looks for those actions in the editor
- **THEN** they are reachable together from one place, rather than each occupying
  its own control in the editor's title area

### Requirement: A diagram editor belongs to one document
A diagram editor SHALL show the document it was opened for and no other, SHALL
name that document, and SHALL be restored showing the same document when the
window is reloaded.

#### Scenario: Two flows open at once
- **GIVEN** diagrams open for `place-order.zfl` and for `cancel-order.zfl`
- **WHEN** the user moves between them
- **THEN** each keeps showing its own flow

#### Scenario: Working on something else
- **GIVEN** a diagram open for a flow
- **WHEN** the user focuses an editor holding a different file
- **THEN** the diagram keeps showing the flow it was opened for

#### Scenario: Reloading the window
- **GIVEN** a diagram open when VS Code is closed or the window is reloaded
- **WHEN** the editor reopens
- **THEN** the diagram is restored, showing the same document

#### Scenario: The user rearranges their tabs
- **GIVEN** a diagram the user has dragged into another editor group
- **WHEN** the document changes and the diagram re-renders
- **THEN** the diagram stays where the user put it

**Rationale:** IntelliJ's tool window needs a file selector because a tool window
is not attached to anything. An editor is, so the selector disappears — the tab
is the selection.

### Requirement: The diagram tracks edits to its document
The diagram SHALL re-render as its document changes, without the user saving the
file or re-invoking the action, and SHALL keep showing the last good diagram
while a new one is being produced.

#### Scenario: Adding a command to a flow
- **GIVEN** a diagram open beside its ZFL text
- **WHEN** the user types a new command into the flow
- **THEN** the diagram shows the new node without a manual refresh

#### Scenario: Typing mid-edit
- **GIVEN** a diagram open and the user typing a declaration that is briefly
  incomplete
- **WHEN** the document cannot be read at that moment
- **THEN** the diagram keeps the previous rendering visible rather than flashing
  an empty state on each keystroke

#### Scenario: A sustained burst of edits
- **GIVEN** a diagram open while the user types continuously
- **WHEN** the document changes many times per second
- **THEN** the diagram is produced for some of those changes and not for every
  one, and the last one typed is always the one finally shown

#### Scenario: The document changes on disk
- **GIVEN** a diagram open for a document that is changed outside the editor,
  such as by a branch switch
- **WHEN** the editor picks the change up
- **THEN** the diagram re-renders from the new content

### Requirement: The user can choose what the diagram shows
The extension SHALL let the user switch a diagram between the flow view and the
service view, and toggle humanised labels, from the diagram's own editor. Each
diagram SHALL keep its own choices for as long as it is open, and SHALL show
which view it is currently displaying.

#### Scenario: Switching to the service view
- **GIVEN** a diagram showing the flow view
- **WHEN** the user switches to the service view
- **THEN** the same model is shown as a service map, and the editor indicates
  that the service view is the one being shown

#### Scenario: Turning off humanised labels
- **GIVEN** a diagram showing humanised labels
- **WHEN** the user turns the option off
- **THEN** labels are shown as written in the model

#### Scenario: A choice survives a re-render
- **GIVEN** a diagram showing the service view
- **WHEN** the user edits the document and the diagram re-renders
- **THEN** it is still showing the service view

#### Scenario: Which view a diagram opens on
- **GIVEN** a user who has set which view diagrams should open on
- **WHEN** they open a diagram
- **THEN** it opens on that view, and they can still switch it afterwards

#### Scenario: Two diagrams, two choices
- **GIVEN** two flows open as diagrams
- **WHEN** the user switches one of them to the service view
- **THEN** the other keeps showing whatever it was showing

### Requirement: The view model passes through the extension untouched
The extension SHALL forward the view model it receives for a document to the
renderer as received, and SHALL NOT read, reshape, validate, supplement or
reorder it. Deciding what a flow contains, and how it is laid out, belongs
upstream.

#### Scenario: The model gains a node type the extension has never heard of
- **GIVEN** a language server that returns a view model containing a node type
  released after the installed extension
- **WHEN** the diagram renders it
- **THEN** what reaches the renderer is what the server sent, node for node and
  field for field — comparable against the server's own answer

#### Scenario: Layout comes from upstream
- **GIVEN** a view model carrying node positions and dimensions
- **WHEN** the diagram renders it
- **THEN** it is laid out as the view model describes, with no positioning
  applied by the extension

**Rationale:** IntelliJ produces this JSON in Kotlin and hands it straight to the
same renderer. Mirroring that means both IDEs show the same picture and only one
implementation decides what a flow looks like. A transformation here would be a
second opinion, and the first thing to diverge.

### Requirement: The diagram explains why it is not showing anything
Where a diagram editor has nothing to render, it SHALL say which of these is the
case: no language server available, the server does not support flow views, or
the document could not be read. The detail SHALL be recorded in the output
channel.

#### Scenario: No language server
- **GIVEN** a diagram opened in a host with no language server
- **WHEN** it is displayed
- **THEN** it states that the diagram needs the ZenWave language server, rather
  than showing an empty canvas

#### Scenario: A server without flow-view support
- **GIVEN** a connected language server that does not support flow views
- **WHEN** the user opens a diagram
- **THEN** it states that the connected server cannot produce one, and
  distinguishes this from the server being absent

#### Scenario: A file with a syntax error
- **GIVEN** a ZFL file with a syntax error and no previously rendered diagram
- **WHEN** the diagram is displayed
- **THEN** it states that the document could not be read, and the underlying
  detail is available in the output channel

#### Scenario: Waiting for a diagram
- **GIVEN** a document whose diagram is being produced
- **WHEN** the user is waiting
- **THEN** the editor shows that it is working, rather than appearing broken

### Requirement: The diagram loads no remote content
A diagram SHALL render entirely from resources shipped with the extension, and
SHALL NOT load code, styles, fonts or data over the network.

#### Scenario: Working offline
- **GIVEN** a machine with no network connection
- **WHEN** the user opens a diagram
- **THEN** it renders normally

#### Scenario: The model stays local
- **GIVEN** a ZFL file describing a private domain
- **WHEN** the diagram renders it
- **THEN** no part of the model leaves the machine
