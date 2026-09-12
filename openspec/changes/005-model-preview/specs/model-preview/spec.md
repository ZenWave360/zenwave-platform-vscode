## Purpose

Show a ZDL or ZFL model beside its text as the documentation and diagrams it
describes, rendered from what the language server produces, so that the picture a
VS Code user sees is the picture an IntelliJ user sees.

## ADDED Requirements

### Requirement: A model file can be previewed beside its text
The extension SHALL offer a preview action for ZDL and ZFL documents, from the
editor and from the command palette, through `zenwave.preview.openToSide` and
`zenwave.preview.open`, and SHALL open the preview beside the editor without
taking focus from the text.

#### Scenario: Opening a preview
- **GIVEN** a `.zdl` file open in the editor
- **WHEN** the user invokes the ZenWave preview action
- **THEN** the preview opens in the column beside the editor, and the cursor
  stays in the text

#### Scenario: Previewing a flow
- **GIVEN** a `.zfl` file open in the editor
- **WHEN** the user invokes the preview action
- **THEN** the preview opens showing that flow's representations

#### Scenario: The action is offered only for model files
- **GIVEN** an editor holding a file that is neither ZDL nor ZFL
- **WHEN** the user looks for the preview action
- **THEN** it is not offered

#### Scenario: Previewing the same file twice
- **GIVEN** a preview already open for a document
- **WHEN** the user invokes the preview action again for that document
- **THEN** the existing preview is revealed rather than a second one opened

### Requirement: The preview can take the place of the text, and give it back
The extension SHALL let the user show the preview in place of the document's text
in the same editor, and SHALL leave an obvious way back to the text. Opening a
model file SHALL continue to show its text by default.

#### Scenario: Replacing the text with the preview
- **GIVEN** a model file open as text
- **WHEN** the user asks to view it as a preview
- **THEN** the preview is shown in that same editor, in the same position among
  the tabs, and the text editor is not left open beside it

#### Scenario: Going back to the text
- **GIVEN** a model file being shown as a preview
- **WHEN** the user asks to edit it again
- **THEN** the text is shown in that same editor, at the position it was left at

#### Scenario: Opening a model file normally
- **GIVEN** a user who has never configured anything
- **WHEN** they open a `.zdl` file from the explorer
- **THEN** they get the text editor, not the preview

#### Scenario: Reloading the window with a preview open
- **GIVEN** a preview open when VS Code is closed or the window is reloaded
- **WHEN** the editor reopens
- **THEN** the preview is restored, showing the same document

### Requirement: A preview belongs to one document
A preview SHALL show the document it was opened for and no other, SHALL name that
document, and SHALL NOT be re-pointed at a different document while it is open.
The extension SHALL NOT move, restore or re-position editors the user has
arranged.

#### Scenario: Two models previewed at once
- **GIVEN** previews open for `orders.zdl` and for `customers.zdl`
- **WHEN** the user moves between them
- **THEN** each keeps showing its own model

#### Scenario: Working on something else
- **GIVEN** a preview open for `orders.zdl`
- **WHEN** the user focuses an editor holding `customers.zdl`
- **THEN** the preview keeps showing `orders.zdl`

#### Scenario: Previewing a second model
- **GIVEN** a preview open for `orders.zdl`
- **WHEN** the user invokes the preview action from `customers.zdl`
- **THEN** a preview for `customers.zdl` is opened, leaving the first one alone

#### Scenario: The user rearranges their tabs
- **GIVEN** a preview the user has dragged into another editor group
- **WHEN** the document changes and the preview re-renders
- **THEN** the preview stays where the user put it

**Rationale:** a preview here is an editor for its document, not a viewport that
roams. The built-in Markdown preview offers both behaviours and needs a locking
command to reconcile them; binding to the document from the start avoids
inventing that concept.

### Requirement: The preview shows the representations the server provides
The preview SHALL present the representations the language server returns for the
document, in the order given, each under the title the server supplies, and SHALL
start on the representation the server nominates as the default. The extension
SHALL NOT invent, reorder or omit representations.

#### Scenario: A ZFL flow with several outcomes
- **GIVEN** a ZFL document whose flow has three end outcomes
- **WHEN** the preview opens
- **THEN** the flowchart and one representation per outcome are offered, under
  the titles the server gave them

#### Scenario: Landing on the most useful view
- **GIVEN** a document for which the server nominates a default representation
- **WHEN** the preview opens
- **THEN** that representation is the one shown first

#### Scenario: Choosing another representation
- **GIVEN** a preview offering several representations
- **WHEN** the user selects a different one
- **THEN** the preview shows it, and keeps showing it as the document changes

#### Scenario: A server that offers one representation
- **GIVEN** a document for which the server returns a single representation
- **WHEN** the preview opens
- **THEN** it is shown without a selector cluttering the panel

### Requirement: The preview keeps step with the document
The preview SHALL re-render as the previewed document changes, without the user
saving the file or re-invoking the action, and SHALL keep the last rendered
content visible while new content is being produced.

#### Scenario: Adding a field to an entity
- **GIVEN** a ZDL file open with its preview showing
- **WHEN** the user types a new field into an entity
- **THEN** the preview reflects the new field without a manual refresh

#### Scenario: Typing mid-declaration
- **GIVEN** a preview open while the user types a declaration that is briefly
  incomplete
- **WHEN** the document momentarily cannot be read
- **THEN** the preview keeps showing the last good content rather than blanking
  on each keystroke

#### Scenario: Editing the file outside the editor
- **GIVEN** a preview open for a document that is changed on disk by another
  program, such as a branch switch
- **WHEN** the editor picks the change up
- **THEN** the preview re-renders from the new content rather than keeping the
  old one

### Requirement: Diagrams render locally
The preview SHALL render diagrams from resources shipped with the extension, and
SHALL NOT require a network connection, a Java runtime, a remote rendering
service, or another extension to be installed.

#### Scenario: A diagram on a machine with no network
- **GIVEN** a machine with no network connection
- **WHEN** the user previews a model containing a diagram
- **THEN** the diagram renders

#### Scenario: A clean VS Code installation
- **GIVEN** VS Code with only the ZenWave extension installed
- **WHEN** the user previews a model containing a diagram
- **THEN** the diagram renders, without a prompt to install anything else

#### Scenario: The model stays local
- **GIVEN** a model describing a private domain
- **WHEN** the preview renders its diagrams
- **THEN** no part of the model leaves the machine

#### Scenario: Content that asks to run or to fetch
- **GIVEN** a representation whose content carries script, or refers to an image
  or a stylesheet elsewhere on the network
- **WHEN** the preview displays it
- **THEN** nothing is executed and nothing is fetched, and the rest of the
  content is still readable

#### Scenario: A diagram that cannot be drawn
- **GIVEN** a representation whose diagram source is malformed
- **WHEN** the preview tries to render it
- **THEN** the preview reports that the diagram could not be drawn and leaves the
  rest of the content readable

### Requirement: The preview reads as part of the editor
The preview SHALL follow the editor's colour theme, including a change of theme
while it is open, and SHALL let the user select and copy its text.

#### Scenario: Switching to a light theme
- **GIVEN** a preview open under a dark theme
- **WHEN** the user switches to a light theme
- **THEN** the preview and its diagrams follow, without being reopened

#### Scenario: Copying from the preview
- **GIVEN** a preview showing rendered documentation
- **WHEN** the user selects a passage
- **THEN** they can copy it as text

### Requirement: The preview explains why it has nothing to show
Where the preview cannot show content, it SHALL say which of these is the case:
no language server available, the server does not support previews, or the
document could not be read. The detail SHALL be recorded in the output channel.

#### Scenario: No language server
- **GIVEN** a preview opened in a host with no language server
- **WHEN** the preview is displayed
- **THEN** it states that the preview needs the ZenWave language server, rather
  than showing an empty page

#### Scenario: A server without preview support
- **GIVEN** a connected language server that does not support previews
- **WHEN** the user opens the preview
- **THEN** it states that the connected server cannot produce one, and
  distinguishes this from the server being absent

#### Scenario: A file with a syntax error and nothing rendered yet
- **GIVEN** a model file with a syntax error, previewed before any good render
- **WHEN** the preview is displayed
- **THEN** it states that the document could not be read, and the detail is
  available in the output channel
