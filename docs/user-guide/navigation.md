# Navigating your design

Your design is a set of connected files: ZFL flows, ZDL bounded contexts, and their OpenAPI, AsyncAPI and Avro files. This page shows how to move between them.

Shortcuts are for Windows and Linux. On macOS, use Cmd instead of Ctrl and Option instead of Alt; to go back and forward, press Ctrl+- and Ctrl+Shift+-.

## The basics

| To do this | Press |
| --- | --- |
| Go to where something is defined | **Ctrl+click** it, or put the cursor on it and press **F12** |
| Peek at the definition without leaving the file | **Alt+F12** |
| Find everything that uses it | **Shift+F12** |
| Go back to where you were | **Alt+Left** |
| Go forward again | **Alt+Right** |

A plain click only moves the cursor. To follow a link, Ctrl+click.

Going back works across files. After a few Ctrl+clicks, press Alt+Left once per step to return.

## What you can follow

| From | Ctrl+click takes you to |
| --- | --- |
| A command in a ZFL flow | Its method in the ZDL of that bounded context |
| An event in a ZFL flow | The event in its ZDL, or where the flow first mentions it |
| A `@zdl("...")` path in a ZFL flow | The ZDL file |
| A rule in `@rules(...)` | The rule in the `rules` block |
| A type, parameter or `withEvents` in a ZDL | Its declaration |
| An `apis` entry in a ZDL | The OpenAPI, AsyncAPI or ZDL file |
| A REST annotation such as `@get` or `@post` | The operation in the OpenAPI file |
| `@asyncapi(...)` on a method | The channel in the AsyncAPI file |
| A `$ref` in OpenAPI or AsyncAPI, or a type in Avro | The referenced schema |

If something has several definitions, VS Code shows a list to pick from. If the target file is missing, nothing opens, and the problem is shown in the Problems panel.

## Find who uses something

Put the cursor on a command, event, rule or type and press **Shift+F12**. The results show every file that uses it, open or not.

Two more commands are in the editor's right-click menu:

- **ZenWave: Go to What This References** lists what the element under the cursor points to.
- **ZenWave: Go to What References This** lists what points to it.

## Find your way inside a file

| To do this | Press |
| --- | --- |
| Jump to a symbol in this file | **Ctrl+Shift+O** |
| See the file's structure | Open the **Outline** view in the Explorer |
| Jump to a line | **Ctrl+G** |

The breadcrumbs above the editor show where the cursor is, for example the aggregate and method. Click one to jump to its siblings.

## Move between files

| To do this | Press |
| --- | --- |
| Open a file by name | **Ctrl+P**, then type part of the name |
| Switch to a recently used file | **Ctrl+Tab** |
| Open the definition beside the current file | **Ctrl+Alt+click**, or **Ctrl+K F12** |

## The Model tree

Open the ZenWave view from the Activity Bar. The Model tree shows the elements of the model you are editing.

- **Click** a node to select it and show its source.
- **Ctrl+click** a node to go to its definition. For a command in a flow, that is its method in the ZDL.
- **Right-click** a node for **Go to Definition**, **Find References**, **Forward References** and **Open Related**. Only the ones that apply are shown.

## Diagrams

In the EventFlow diagram, click a node to select it, and Ctrl+click it to go to its definition. Right-click for the same menu as in the Model tree.

The Mermaid diagrams in the preview are pictures. Clicking them does nothing; use the text or the Model tree to navigate.
