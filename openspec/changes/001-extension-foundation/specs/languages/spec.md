# languages — delta for change 001

## ADDED Requirements

### Requirement: ZDL and ZFL files are recognised by extension
The extension SHALL register a `zdl` language for `.zdl` and `.zw` files, and a
`zfl` language for `.zfl` files, each with a distinguishing file icon.

#### Scenario: Opening a ZDL file
- **GIVEN** a file named `customer.zdl`
- **WHEN** the user opens it
- **THEN** the editor reports the language as ZDL, and the file shows the
  ZenWave icon in the explorer

#### Scenario: Opening a ZFL file
- **GIVEN** a file named `place-order.zfl`
- **WHEN** the user opens it
- **THEN** the editor reports the language as ZFL

### Requirement: ZDL and ZFL are syntax highlighted without any external dependency
The extension SHALL provide TextMate grammars for ZDL and ZFL that highlight
keywords, types, annotations, string and numeric literals, comments and
documentation comments. Highlighting SHALL NOT depend on a language server, a
network connection, an installed JVM, or a grammar contributed by another
extension.

#### Scenario: Highlighting in the web host with no server available
- **GIVEN** a ZDL file open in a browser-based VS Code
- **WHEN** the file is displayed
- **THEN** it is syntax highlighted

#### Scenario: Documentation comments are distinguishable
- **GIVEN** a ZDL or ZFL file containing both a `//` line comment and a `/** */`
  documentation comment
- **WHEN** the file is displayed
- **THEN** each is highlighted as a comment, and the documentation comment is
  distinguishable from the ordinary one

#### Scenario: Nested blocks do not end their parent early
- **GIVEN** a `config { plugins { … } }` section declaring several plugins, each
  with its own braced body
- **WHEN** the file is displayed
- **THEN** every plugin is highlighted, not only the first — each plugin name
  reads as a named declaration and each of its options reads as a field

#### Scenario: Comment text does not leak into the rest of the file
- **GIVEN** a comment containing an apostrophe, a quote or a brace — for example
  `the processor's response`
- **WHEN** the file is displayed
- **THEN** the comment is highlighted as a comment, and the code after it is
  highlighted normally rather than being absorbed into a string or block

**Note:** these grammars are the *fallback* highlighting layer. When the language
server provides semantic tokens, those take precedence; the grammars remain so
that a file is never left unhighlighted.

### Requirement: Editors behave idiomatically for both languages
The extension SHALL configure comment toggling, bracket matching, auto-closing
pairs, surrounding pairs and indentation rules for ZDL and ZFL.

#### Scenario: Toggling a comment
- **GIVEN** the cursor on a line in a ZDL file
- **WHEN** the user invokes Toggle Line Comment
- **THEN** the line is commented using the ZDL line-comment syntax

#### Scenario: Typing an opening brace
- **GIVEN** the cursor in a ZFL file
- **WHEN** the user types an opening brace
- **THEN** the matching closing brace is inserted automatically

#### Scenario: Folding a block
- **GIVEN** a ZDL file containing a multi-line entity declaration
- **WHEN** the user folds at the declaration line
- **THEN** the body collapses to a single line
