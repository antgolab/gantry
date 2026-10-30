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
PROPOSAL -> SPEC -> DESIGN -> TASKS -> DEV -> TEST -> REVIEW -> INTEGRATION
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
/gantry-archive
```

Common commands:

| Command | Purpose |
|---|---|
| `/gantry-change` | Start the default full change flow (for a low-risk change use `gantry change --tier light --scope …`, which enters the light fast loop directly) |
| `/gantry-next` | Advance to the next phase (dev tasks execute automatically) |
| `/gantry-auto` | Autopilot: advance multiple phases with human-approval gates preserved |
| `/gantry-archive` | Integrate and archive a completed change |
| `/gantry-status` | Show current state |
| `/gantry-resume` | Resume interrupted work |
| `/gantry-adjust` | Apply a change patch (open PATCH.md loop when things shift mid-flight) |
| `/gantry-review` | Run code or requirement review |
| `/gantry-debug` | Systematic debugging |
| `/gantry-context <sub>` | Project context, architecture and knowledge base (`scan` / `architect` / `evolve` / `knowledge capture` / `knowledge curate`) |
| `/gantry-health` | Run a codebase health check |
| `/gantry-unarchive` | Restore an archived change |

_Internalized (no longer surfaced as user entrypoints)_: `exec` (auto-triggered inside `/gantry-next` or `/gantry-auto` at dev stage), `fast` (the light pipeline's only stage, entered via `gantry change --tier light`), `knowledge` (folded into `/gantry-context knowledge <sub>`). Existing scripts still work through the CLI.

### Terminal CLI

The CLI handles state-machine operations, installation, archiving, and the unattended convergence loop:

```bash
gantry change "Add CSV export to the orders list"
gantry status
gantry archive

# Convergence engine (see docs/loop.md)
gantry loop-next                     # read-only: prints the next whitelist token
gantry advance                       # advance one step; entry inlines loop-guard breaker
gantry heal T02 --reason "…"         # record a DEV verify failure into EXECUTION.md
gantry heal --check T02              # query R2.5 3-attempt ceiling
# AC coverage hard gate runs at the integration gate (fail-closed since 2026-10-12:
# every SPEC AC must be covered by a `covers` entry in .gantry/loop/test-commands.yml,
# which `gantry install` seeds as a commented template); no standalone ac-gate command
```

### Unattended Convergence Loop

`gantry loop` is a self-driving convergence engine built on the state machine. `gantry loop <client> [--quiet]` (client ∈ `claude` | `codex`) reads `STATE.md`, dispatches each phase to a fresh headless AI client, runs the real gates, and advances one step at a time. Recoverable failures re-enter bounded diagnosis and repair; approval, cancellation, unsafe process state, and exhausted budgets stop according to their actual reason.

See [`docs/loop.md`](docs/loop.md) for configuration, task verification, failure recovery, circuit breakers, AC execution evidence, output, and exit codes.

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
PROPOSAL -> SPEC -> DESIGN -> TASKS -> DEV -> TEST -> REVIEW -> INTEGRATION
```

Typical flow:

```bash
gantry change "Describe the requirement"   # -> PROPOSAL.md
/gantry-auto                               # -> SPEC.md -> DESIGN.md (pauses at design gate)
/gantry-auto                               # -> TASKS.md -> DEV -> TEST -> REVIEW (pauses at integration gate)
gantry archive                             # -> INTEGRATION + archive
```

Lightweight MVP flow:

```bash
gantry change --tier light --scope <p,...> "Describe a low-risk fix"
gantry advance  # exit gate: CLI runs verify + diff guard
```

This produces `light.json` and `EXECUTION.md` — no `PROPOSAL.md` and no human gate.
The exit gate auto-archives on success, or auto-upgrades to `full@change` (code kept)
when it detects out-of-scope edits, red lines, or weakened tests. Schema, public API,
cross-module, dependency, security, concurrency, and destructive changes must use the
default full flow. Optionally enable `jev.enabled` (config) + `TYPESAFE_API_KEY` to add a semantic red-line precheck to the light entry — off by default; see [docs/jev.md](docs/jev.md).

---

## Structural Guarantees

| Mechanism | How it works | Failure mode addressed |
|---|---|---|
| Phase gates | The CLI refuses to advance when required artifacts are missing | Skipped process |
| Context boundaries | Each DEV wave gets a new subagent; every task refreshes its context pack and remains independently verified and committed | Long-context collapse |
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
| `docs/loop.md` | Unattended convergence loop: configuration, verification, recovery, circuit breakers, and AC execution evidence |
| `docs/prototype.md` | Optional pre-design prototypes and review-time simplification boundaries |
| `docs/testing-strategy.md` | Deterministic behavior evaluations and optional real-model test runs |
| `README.md` | Installation and usage overview |

Phase protocols:

| File | Purpose |
|---|---|
| `phases/0-change.md` | Clarify a vague idea into a change proposal |
| `phases/1-requirement.md` | Produce requirements, acceptance criteria, and CONTEXT candidate patches |
| `phases/2-design.md` | Produce technical design, risk analysis, and § 8 UI direction/design tokens when PROPOSAL uiImpact=true |
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

- [x] 8-phase pipeline and CLI state machine
- [x] Claude Code / Cursor / Codex / Copilot command distribution
- [x] Brownfield guardrails
- [x] `LESSONS.md` knowledge base and `/gantry-context knowledge curate`
- [x] project convention templates
- [x] Unattended convergence loop (P1 `loop-next` · P2 driver + inlined guard · P3 `heal` + integration AC hard gate)
- [x] light fast lane replaces micro: `gantry change --tier light --scope …` + exit-gate diff guard, no human gate
- [x] `/gantry-auto` AI decision log channel (autonomous=true)
- [x] optional Jev semantic precheck on the light entry (off by default)
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
