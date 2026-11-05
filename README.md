# ZenWave Platform: Design, Review, Generate and Explore your Domain Models and APIs

A domain modeling platform. It gives structure to your domain discovery (Event Storming, domain modeling) in models that your AI agents can understand and your architects and developers can edit and validate.

> **Early access, work in progress.**
> Feedback and questions at [GitHub Discussions](https://github.com/ZenWave360/zenwave-platform-vscode/discussions).

> 📸 **Screenshot (hero):** VS Code with a ZDL file on the left and its preview on the right, showing a class diagram of an aggregate. The ZenWave status bar item visible at the bottom.

## Why ZenWave Platform

ZenWave brings structure to your Spec Driven Development workflows and navigation to your API landscape.

ZenWave keeps the design in two small text languages that read like compressed code and live in your repository, next to the APIs and the code itself:

- **[ZFL](https://www.zenwave360.io/docs/event-driven-design/zenwave-flow-language/)** models business flows across bounded contexts. It is the textual counterpart of an Event Storming board.
- **[ZDL](https://www.zenwave360.io/docs/event-driven-design/zenwave-domain-language/)** models what is inside a bounded context: aggregates, entities, services, commands, events and APIs.

From those models the extension gives you three things:

1. **Design.** An editor that validates your models and shows them as diagrams and documents while you type.
2. **Generate.** A runner for the ZenWave SDK that turns models into APIs, backend code and contract tests.
3. **Explore.** A browser for all the APIs and models of your organization, declared in one architecture manifest.

It runs in desktop VS Code and also in the browser, in [vscode.dev](https://vscode.dev) and [github.dev](https://github.dev). Open any repository with ZenWave models on GitHub, press `.`, and you can read and edit the design without installing anything on your machine.

## 1. Design: edit, validate and see your models

### Structure your Event Storming

Write the flow you discovered on the board as a ZFL flow. Each step has a place: who issues the command, which bounded context handles it, which event comes out, and what happens next. The happy path and every alternative path are written down, not left as a note in the corner of the board.

> 📸 **Screenshot:** a ZFL flow next to a photo-like Event Storming board, showing how sticky notes map to commands, events and policies in the text.

### Model your bounded contexts

Then go inside each bounded context with ZDL. Design your aggregates and their state machines, the commands they accept and the domain events they publish. Expose them through APIs, so you also see how the context talks to the outside world.

> 📸 **Screenshot:** a ZDL file with an aggregate, its state machine, its commands and events, and an API section exposing them.

### Navigate across your whole design

Your design is a set of connected files. A flow points to the bounded contexts that take part in it. A bounded context points to its APIs. You can follow those links in both directions: from a step in a flow to the command in its bounded context, from an event to the API that publishes it, and back.

Errors show up while you type, in every file, so a renamed command or a missing event is caught where it breaks the design.

A ZFL flow's `systems` block lists the services and commands its flows use. Above it, **Add missing** adds what the flows use and the block lacks, and removes nothing. **Full** also removes what no flow uses, and asks first. Both are also in the Command Palette, as **Add Missing ZFL Services** and **Organize ZFL Services in Full**.

> 📸 **Screenshot:** Go to Definition from an event in a ZFL flow, landing on the same event in the ZDL of its bounded context.

### See your models as documents

A model is only useful if the business can read it. The preview turns every model into Markdown documents with Mermaid diagrams:

- A **ZDL** model shows its documentation page for the bounded context, with its classes and diagrams. **ZDL Diagrams** shows one diagram at a time instead, chosen by kind (services, aggregates, state machines, events, commands, other entities) and by element.
- A **ZFL** flow shows its flowchart and one sequence diagram per outcome, with selectors for the diagram and for how sequence variants are rendered.
- A **ZW** file shows each plugin with its description, the command to run it, and its own and inherited configuration.

Open it from the ZenWave icon in the editor title bar, with **ZenWave: Open Preview** (`Ctrl+Shift+V`) or **Open Preview to the Side** (`Ctrl+K V`). The preview follows your edits, keeps the last good drawing while the model cannot be read, and follows your colour theme. Mermaid ships inside the extension, so nothing goes to the network. **Copy as Markdown**, in the preview's title bar, copies the document so you can paste it into a wiki or a pull request. **Open Following Preview** opens one preview beside the text that shows whichever model you focus last and remembers the mode, diagram and scroll position of each file, and the lock in its title bar turns it into an ordinary preview of the current file.

> 📸 **Screenshot:** a ZFL flow preview showing the flowchart on top and one sequence diagram below, with the diagram selector visible.

> 📸 **Screenshot:** a ZDL preview of a bounded context, showing the class diagram and the generated documentation sections.

### EventFlow diagram

ZFL flows also open as an EventFlow diagram, drawn by the same renderer the IntelliJ plugin uses. Open it from the ZenWave icon in a flow's editor title bar, beside the text or in its place. **Reopen Editor With…** or **Show ZFL Text** takes you back to the text.

The diagram follows your edits as you type. It opens zoomed as far out as fits, with the flow's first start in view. You can switch between the flow view and the service view, and turn humanized labels on or off. When there is nothing to draw, it tells you why. With a language server that supports it, **Save positions** in the full diagram writes your arrangement beside the model (`checkout.zfl.positions.json`), and **Discard Saved Positions** in the title bar menu deletes it to go back to automatic layout.

> 📸 **Screenshot:** the EventFlow diagram of a business flow across three bounded contexts, with commands, events and policies, and the view switcher in the title bar.

### Event storming editor (in progress)

A visual editor to build ZFL flows the way you would on an Event Storming board, with the text model kept in sync.

## 2. Generate: run the ZenWave SDK

The same models generate your software. The extension runs the [ZenWave SDK](https://github.com/ZenWave360/zenwave-sdk) the same way the command line does, so you can produce:

- API specifications: AsyncAPI and OpenAPI
- Backend code for your bounded contexts
- Contract tests

SDK plugins get completion and hover help while you write their configuration. That help comes from the SDK installed on your machine or, when there is none, from a catalogue shipped with the extension, and the extension tells you which one you are seeing. Each enabled plugin declaration has a **Run** CodeLens above it. Click it and the code is generated.

Code generation runs on the desktop only, in trusted workspaces. The SDK runs on the JVM, launched through JBang, so it cannot run inside a browser. In vscode.dev the extension hides the action instead of showing a button that fails.

> 📸 **Screenshot:** a ZDL file with plugin declarations, the Run CodeLens above one of them, and the terminal output of a generation run below.

## 3. Explore: your architecture model

Most organizations cannot answer a simple question: which APIs and events exist, who owns them, and which bounded context publishes them. ZenWave answers it from one place.

Describe your systems, bounded contexts, APIs and models in an **architecture manifest**, a YAML file. The extension reads it and lets you explore everything it declares. It works as an API portal and an event catalog, inside your editor and next to the models it describes.

Point the extension to your manifest with the `zenwave.workspace.manifest` setting, or with `project-manifest` in `.zenwave/config.yml`. The language server validates the manifest too.

> 📸 **Screenshot:** the architecture explorer listing systems and bounded contexts, with one API selected and its details open.

> 📸 **Screenshot:** the event catalog view showing an event, the context that publishes it and the contexts that consume it.

## Desktop and browser

| | Desktop | Browser (vscode.dev, github.dev) |
|---|:---:|:---:|
| Editing and validation (language server) | ✅ | ✅ |
| Preview with diagrams and documents | ✅ | ✅ |
| EventFlow diagram | ✅ | ✅ |
| Architecture explorer | ✅ | ✅ |
| ZenWave SDK code generation | ✅ | ❌ (needs a JVM) |

## Getting started

1. Install **ZenWave Platform** from the Marketplace, or open a repository in vscode.dev and install it there.
2. Open a `.zdl` or `.zfl` file. Highlighting and validation start right away.
3. Click the ZenWave icon in the editor title bar to open the preview or the EventFlow diagram.
4. To generate code, install the ZenWave SDK and use the **Run** CodeLens on a plugin declaration.

## Settings

| Setting | What it does |
|---|---|
| `zenwave.workspace.manifest` | Path to the architecture manifest |
| `zenwave.eventflow.defaultView` | View the EventFlow diagram opens with |
| `zenwave.eventflow.humanizeLabels` | Show humanized labels in the EventFlow diagram |

## Replaces ZDL VSCode

This extension supersedes **ZDL VSCode** (`ZenWave360.zdl-vscode`). Uninstall the old one after installing this one.

## Contributing

Development setup, sibling repositories and release builds are described in [CONTRIBUTING.md](https://github.com/ZenWave360/zenwave-platform-vscode/blob/main/CONTRIBUTING.md). Design documentation lives in [zenwave-specs](https://github.com/ZenWave360/zenwave-specs/tree/main/zenwave-platform-vscode).

## License

MIT