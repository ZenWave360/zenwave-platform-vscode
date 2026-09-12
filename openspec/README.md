# Spec-Driven Development in this repo

This project uses an **OpenSpec-style** workflow, adapted. Read this once before
writing a spec or a line of code.

Upstream reference: [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec).
We use the tool *and* its conventions, with one deliberate deviation.

Install it with `npm i -g @fission-ai/openspec` — note the scope. The unscoped
`openspec` package on npm is an empty placeholder stuck at 0.0.0.

## The deliberate deviation

**Specs are not the single source of truth.** The upstream framing is
"`specs/` is the source of truth for current behaviour." We reject that framing.
Here:

> **The spec and the code are jointly authoritative.**
> The spec owns *observable behaviour and contracts*.
> The code owns *implementation, structure and performance*.

The practical test for whether something belongs in a spec: **could a user or a
neighbouring system notice it?** A command id, an activation condition, a
rendered output, a settings key, a fallback when a dependency is missing — those
are spec material. Which bundler we use, how a class is factored, whether a
helper is memoised — those are code's business, and a spec that dictates them is
overreach.

When spec and code disagree, that is a **bug in one of them**, and the fix is a
decision, not an automatic rewrite of the code to match the document. Sometimes
the code learned something the spec did not know.

## Layout

```
openspec/
├── README.md      ← you are here: the convention
├── config.yaml    ← schema + the read-only reference to the zenwave-specs store
├── project.md     ← project context, conventions, capability roadmap
├── specs/         ← living behavioural contract, one folder per capability
│   └── <capability>/spec.md
├── changes/       ← proposed, in-flight changes (each self-contained)
│   └── NNN-slug/
│       ├── proposal.md   ← why, what changes, capabilities, impact
│       ├── design.md     ← technical approach + tradeoffs (optional for small changes)
│       ├── tasks.md      ← implementation checklist
│       └── specs/<capability>/spec.md   ← the DELTA, not the full spec
└── archive/       ← completed changes, kept for their reasoning
    └── NNN-slug/
```

`config.yaml` is what makes this a healthy OpenSpec root — without it
`openspec doctor` reports `unhealthy`. It also declares `zenwave-specs` as a
**read-only reference**, so you can read cross-repo contracts from here without
this repo ever writing into the shared store. See "Local or shared?" below.

`specs/` starts **empty**. It is a greenfield project: there is no current
behaviour yet. Capabilities appear in `specs/` only when a change that added
them is archived. This is the whole point of delta tracking — you never edit
`specs/` directly, you propose a delta against it.

## Lifecycle

| Stage | What happens | Command |
| --- | --- | --- |
| **1. Propose** | Scaffold `changes/NNN-slug/`, then write `proposal.md`, delta specs and `tasks.md` (+ `design.md` if there are real tradeoffs). | `openspec new change <name>` |
| **2. Review** | Argue about the *requirements*, before any code exists. This is where the leverage is. | `openspec validate <name> --strict` |
| **3. Apply** | Implement, ticking off `tasks.md`. Discoveries that change behaviour go back into the delta spec — the proposal is allowed to learn. | `openspec status --change <name>` |
| **4. Archive** | Fold the deltas into `specs/<capability>/spec.md` and move the folder into `archive/`. | `openspec archive <name>` |

Step 4 is the one everybody skips and it is the one that keeps `specs/` honest.
A change is not done when the code merges; it is done when the living spec
reflects what actually shipped. `openspec archive` does the fold for you and
validates first — there is no longer an excuse to skip it.

Useful while working:

```bash
openspec list                    # in-flight changes, with task progress
openspec list --specs            # the capability inventory (what already exists)
openspec show <id> --type spec   # read a capability in full
openspec view                    # interactive dashboard
openspec validate --all --strict # everything, before you push
openspec doctor                  # is this a healthy root? do references resolve?
```

`openspec list` shows *changes*, not specs — reach for `--specs` when you want
to know what the project already covers. Mixing those up is the usual way a
near-duplicate capability gets introduced.

## Delta format

Delta specs use three top-level operation headings. Only include the ones you need.
A delta that introduces a **new** capability also opens with `## Purpose`
(one or two sentences, 50+ characters); an existing capability omits it.

`openspec templates` prints the canonical templates the schema will validate
against, and `openspec instructions specs` prints the guidance behind them.

```markdown
## Purpose
What this capability is for. New capabilities only — delete for an existing one.

## ADDED Requirements

### Requirement: Preview stays in sync with the editor
The preview SHALL re-render when the underlying document changes, without the
user re-invoking the command.

#### Scenario: Editing a ZDL file with the preview open
- **GIVEN** a `.zdl` file open with its preview showing
- **WHEN** the user types a new field into an entity
- **THEN** the preview reflects the new field without a manual refresh

## MODIFIED Requirements

### Requirement: <exact heading of the requirement being changed>
<the full new text of the requirement — not a diff fragment>

## REMOVED Requirements

### Requirement: <exact heading being removed>
**Reason:** <why> — **Migration:** <what users/callers should do instead>
```

Rules that matter:

- **`MODIFIED` carries the complete replacement text**, not a patch. The
  archived result must be readable on its own.
- **The `### Requirement:` heading is the identity.** To rename a requirement,
  `REMOVED` the old one and `ADDED` the new one — otherwise archiving cannot
  match them up.
- **Use SHALL** for the requirement sentence. It is a contract, and RFC-2119
  language makes the strength of the obligation explicit. Use SHOULD only when
  you genuinely mean "unless there is a good reason not to".
- **Every requirement needs at least one `#### Scenario:`**. A requirement
  without a scenario is a wish. The scenario is what makes it testable, and is
  usually the thing that reveals the requirement was vague.
- **Write scenarios in the user's vocabulary**, not the implementation's.
  "the user opens a ZDL file" — not "the `onLanguage:zdl` activation event fires".
- **A change must touch at least one capability**, or `openspec validate`
  rejects it. For genuine no-behaviour work (refactor, tooling, docs), set
  `skip_specs: true` in the change's `.openspec.yaml` rather than inventing a
  requirement to satisfy the validator.

On scenario style: the schema template uses `**WHEN**` / `**THEN**`. We also
write a leading `**GIVEN**` where it adds context — the validator accepts it,
including under `--strict`. Prefer the fuller form when the precondition is not
obvious from the scenario title.

## Capability granularity

A capability is a coherent slice of user-visible behaviour, named for what it
does for the user. Roughly: if two things would always be specified, reviewed
and broken together, they are one capability.

See `project.md` for this project's capability map.

## Local or shared? (the zenwave-specs store)

The ZenWave toolchain is nine repositories, and a real feature touches three or
four at once. Contracts that cross repos used to live in chat logs. They now
live in a shared OpenSpec store, `zenwave-specs`.

Every product repo — this one included — is **its own OpenSpec root**, and also
declares the store as a read-only reference in `config.yaml`. So:

| Where | What goes there |
| --- | --- |
| **This repo** | Behaviour only this VS Code client has. Activation, capability gating, grammars, preview UI, the SDK runner's editor affordances. |
| **`zenwave-specs`** | Contracts that bind repos together. The LSP protocol surface, the `FlowViewModel` / `ServiceViewModel` shapes, manifest semantics, the `zenwave-sdk` CLI contract. |

The test: **would breaking this break another repo?** Yes → store. No → local.

`001-extension-foundation` is local, and correctly so — nothing outside this
repo consumes dual-host activation.

```bash
openspec show <spec-id> --type spec --store zenwave-specs   # read a contract
openspec new change <id>                                    # local work
openspec new change <id> --store zenwave-specs              # cross-repo contract
```

Because the reference is read-only, local work can never land in the store by
accident: writing there takes an explicit `--store zenwave-specs`.

## Where non-spec documents go

`docs/` holds architecture and decision records — things that are true about the
codebase but are not behavioural requirements. Cross-link them from `design.md`
rather than copying them into specs.
