# Gantry

[![npm](https://img.shields.io/npm/v/@mmmjk/gantry)](https://www.npmjs.com/package/@mmmjk/gantry)
[![license](https://img.shields.io/github/license/antgolab/gantry)](https://github.com/antgolab/gantry/blob/main/LICENSE)

> **A protocol-driven AI engineering framework.**
> Gantry turns AI-assisted development from ad-hoc chat into a traceable, reviewable, and verifiable engineering process.

[中文文档](README.zh-CN.md)

Gantry is an engineering control layer for AI-assisted software development. It gives humans and agents a shared protocol for moving an idea into production-ready code through requirements, design, tasks, implementation, testing, review, integration, and knowledge capture.

Gantry does not rely on long chat history or model memory. Instead, it makes the process explicit with persistent artifacts, phase gates, task boundaries, verification commands, review loops, and reusable project knowledge.

The goal is simple: **make AI coding scalable without letting engineering discipline collapse.**

---

## Why Gantry?

AI can already generate code quickly. The harder problem is keeping that work understandable, bounded, tested, reviewable, and recoverable across sessions, models, and teammates.

Gantry targets the common systemic failures of AI coding:

- skipped requirements, design, tests, or review
- context collapse in long conversations
- scope drift and unrelated edits
- hard-to-review diffs
- missing verification evidence
- lost decisions and repeated mistakes
- project knowledge trapped in chat history

Gantry turns those risks into a structured engineering protocol.

---

## Core Idea

Most AI coding tools solve the capability problem: they help AI write better code, complete faster, and understand more context.

Gantry solves the next-level process problem: **when AI is already capable enough, how does the software engineering process stay rigorous?**

When an engineer uses multiple AI assistants and produces thousands of lines of code per day, the bottleneck is no longer generation speed. The bottleneck is maintaining engineering discipline: whether requirements were truly understood, whether design decisions were reasoned through, whether tests came from acceptance criteria, and whether risky changes were evaluated before implementation.

Gantry encodes that discipline as an executable system through phase gates, artifact constraints, and a state machine.

---

## Architecture

Gantry is an **artifact-driven state machine**. Each change is split into ordered phases. Each phase produces a Markdown artifact, and downstream phases use upstream artifacts as their source of truth.

```text
PROPOSAL -> SPEC -> DESIGN -> [UI-DESIGN] -> TASKS
                                                     |
                             ARCHIVE <- INTEGRATION <- REVIEW <- TEST <- DEV
```

Gantry provides three interaction layers:

```text
User intent
    |
    v
+--------------------------------------------------+
| IDE slash commands  (/gantry-change, etc.)        |  primary daily path
| CLI state machine   (gantry install/change/archive)| install, create changes, archive
| @ reference layer   (docs/GO.md, phases/*.md)     | fallback for any AI tool with file references
+--------------------------------------------------+
    |
    v
Phase protocols in phases/*.md
    |
    v
.gantry/specs/<change-id>/*.md
```

A completed change can produce:

```text
.gantry/specs/my-feature/
├── PROPOSAL.md
├── SPEC.md
├── DESIGN.md
├── TASKS.md
├── EXECUTION.md
├── T01-SUMMARY.md
├── TEST.md
└── REVIEW.md
```

That archive becomes the next AI session's reliable context.

---

## Installation

```bash
npm install -g @mmmjk/gantry
```

Initialize a target project and install client command integrations:

```bash
cd your-project
gantry install --tool claude   # options: claude / codex / cursor / copilot / all
```

`gantry install` will:

- create `.gantry/planning/STATE.md`
- create `.gantry/planning/config.json`
- copy `.gantry/core/phases/*.md`
- install public skills or prompt files for the selected AI tool
- write the Gantry rules block into `CLAUDE.md` / `AGENTS.md` where applicable

Running `gantry install` again syncs or reinstalls client command integrations while preserving existing `.gantry/planning/` state.

---

## Usage

### IDE Slash Commands

After `gantry install`, use:

```text
/gantry-change "Add CSV export to the orders list"
/gantry-next
/gantry-exec
/gantry-archive
```

Common commands:

| Command | Purpose |
|---|---|
| `/gantry-change` | Start the default full change flow |
| `/gantry-fast` | Start an explicit low-risk light flow |
| `/gantry-next` | Advance to the next phase |
| `/gantry-exec` | Execute tasks from `TASKS.md` |
| `/gantry-archive` | Integrate and archive a completed change |
| `/gantry-status` | Show current state |
| `/gantry-resume` | Resume interrupted work |
| `/gantry-adjust` | Apply a change patch |
| `/gantry-review` | Run code or requirement review |
| `/gantry-context scan` | Scan an existing project and build context |
| `/gantry-knowledge curate` | Maintain project knowledge |
| `/gantry-health` | Run a codebase health check |

### Terminal CLI

The CLI handles state-machine operations, installation, and archiving:

```bash
gantry change "Add CSV export to the orders list"
gantry status
gantry archive
```

### Universal GO.md Entry

For tools that support file references, use:

```text
docs/GO.md

Design the appointment scheduling module for a clinic website
```

`GO.md` detects the appropriate phase, creates a change ID, loads the required artifacts, and asks clarifying questions when needed.

---

## Full Workflow

```text
PROPOSAL -> SPEC -> DESIGN -> [UI-DESIGN] -> TASKS -> DEV -> TEST -> REVIEW -> INTEGRATION -> ARCHIVE
```

Typical flow:

```bash
gantry change "Describe the requirement"   # -> PROPOSAL.md
/gantry-next                               # -> SPEC.md
/gantry-next                               # -> DESIGN.md
/gantry-next                               # -> TASKS.md
/gantry-exec                               # -> DEV
/gantry-next                               # -> TEST
/gantry-next                               # -> REVIEW
gantry archive                             # -> INTEGRATION + archive
```

Lightweight MVP flow:

```bash
gantry change --pipeline light "Describe a low-risk fix"
/gantry-next  # confirm Change, then enter Fast
/gantry-next  # verify and enter Integration
```

This produces `PROPOSAL.md` and `EXECUTION.md`. Schema, public API, cross-module,
dependency, security, concurrency, and destructive changes must use the default full flow.

---

## Structural Guarantees

| Mechanism | How it works | Failure mode addressed |
|---|---|---|
| Phase gates | The CLI refuses to advance when required artifacts are missing | Skipped process |
| Context boundaries | Each task can run in a fresh context using Markdown artifacts as state | Long-context collapse |
| Declared file scope | Tasks declare writable files and verify diffs before completion | Scope drift |
| Risky-change protocol | Destructive or public-interface changes require reference checks | Hidden breakage |
| Knowledge base | UAT failures and lessons are captured into reusable project knowledge | Knowledge loss |
| Convention drift checks | Project conventions are compared against implementation over time | Rule drift |
| Brownfield guardrails | Project context and architecture are scanned before work begins | Inconsistent architecture |

---

## When To Use It

| Scenario | Fit |
|---|---|
| Feature changes over 100 lines that need traceability | Strong fit |
| Team development with code review requirements | Strong fit |
| Long-lived projects where AI context must survive sessions | Strong fit |
| Brownfield projects where architecture alignment matters | Strong fit |
| Tiny one-off scripts or trivial bug fixes | Usually skip Gantry |
| Pure experiments or hackathon prototypes | Usually too much process |

---

## File Map

Core documents:

| File | Purpose |
|---|---|
| `docs/METHODOLOGY.md` | Methodology overview and phase model |
| `docs/RULES.md` | System-level rules for AI-assisted development |
| `README.md` | Installation and usage overview |

Phase protocols:

| File | Purpose |
|---|---|
| `phases/0-change.md` | Clarify a vague idea into a change proposal |
| `phases/1-requirement.md` | Produce requirements, acceptance criteria, and CONTEXT candidate patches |
| `phases/2-design.md` | Produce technical design and risk analysis |
| `phases/2a-ui-design.md` | Produce UI direction and design tokens |
| `phases/3-task.md` | Split design into executable tasks |
| `phases/4-dev.md` | Execute one task with verification |
| `phases/5-test.md` | Derive test matrix and UAT scripts |
| `phases/6-review.md` | Run spec compliance and code quality review |
| `phases/7-integration.md` | Guide UAT, integration, lessons, and archive |

Templates:

| File | Purpose |
|---|---|
| `templates/PROPOSAL.md` | Change proposal |
| `templates/SPEC.md` | Requirements, acceptance criteria, and candidate project-context updates |
| `templates/CONTEXT.md` | Project-level rules layer, created by context scan and evolved through reviewed patches |
| `templates/CONVENTIONS.md` | Project conventions |
| `templates/ARCHITECTURE.md` | Project architecture |
| `templates/DESIGN.md` | Change-level technical design |
| `templates/TASKS.md` | Task list |
| `templates/TEST.md` | Test plan |
| `templates/REVIEW.md` | Review report |
| `templates/EXECUTION.md` | Execution log |
| `templates/LESSONS.md` | Structured cross-change failure knowledge base |

---

## Roadmap

### v1.x

- [x] 9-phase pipeline and CLI state machine
- [x] Claude Code / Cursor / Codex / Copilot command distribution
- [x] Brownfield guardrails
- [x] `LESSONS.md` knowledge base and `/gantry-knowledge curate`
- [x] project convention templates
- [ ] `gantry doctor`
- [ ] stronger error recovery and 人工确认关卡 system
- [ ] 90%+ test coverage

### v2.x

- AI-assisted gate evaluation
- artifact quality scoring
- intelligent context trimming
- semantic deduplication for lessons
- GitHub Actions integration
- pre-commit diff-boundary checks
- metrics dashboard

### v3.x

- wave-based parallel execution
- role-aware routing
- conflict detection
- agent handoff protocol
- knowledge graph for project lessons and ADRs

---

## License

MIT
