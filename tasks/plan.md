# Implementation Plan: Headless Overnight Workflow

## Overview

Build a repository-local, dependency-free Node.js runner that turns an implementation document into a durable task queue, delegates bounded edits to Codex with tiered models, independently runs deterministic quality gates, checkpoints verified changes, and writes a morning report.

## Architecture Decisions

- Use `codex exec` instead of an interactive TUI so the workflow can run unattended.
- Use a strong planner/reviewer, Luna workers, and Terra/Sol escalation only after failures.
- Never trust an agent's claim that tests passed; the controller maps a fixed verification profile to repository-owned commands and checks exit codes itself.
- Keep runtime state and logs under `auto-workflow/.runs/`, ignored by Git, so interrupted runs can resume.
- Use one writer in an isolated Git worktree. Do not push, merge, deploy, delete worktrees, or access production automatically.
- Require a clean starting tree before auto-commit is enabled, preventing user changes from being swept into checkpoints.

## Task List

### Phase 1: Durable core

- [x] Define configuration, plan, task, run-state, and report formats.
- [x] Test dependency scheduling, crash recovery, retry routing, and command construction.
- [x] Implement process execution with deadlines and append-only logs.

### Phase 2: Codex orchestration

- [x] Generate a small, dependency-aware JSON plan with a read-only Sol pass.
- [x] Execute one task at a time with Luna and escalate repeated failures to Terra/Sol.
- [x] Run fixed verification profiles independently and checkpoint only passing tasks.
- [x] Run final full gates and a read-only Sol review.

### Phase 3: Operator experience

- [x] Add safe defaults tailored to this repository.
- [x] Add a one-command worktree launcher, dry-run mode, status output, and morning report.
- [x] Document setup, resume behavior, terminal states, costs, and safety boundaries.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Agent emits unsafe verification commands | High | Agents choose only a named profile; commands come exclusively from checked-in configuration. |
| A failed task corrupts later work | High | Sequential writer, dependency blocking, verification before checkpoint, durable failure evidence. |
| Run consumes unlimited time or calls | High | Wall-clock deadline, per-process timeout, max Codex calls, bounded retry ladder. |
| User changes are committed accidentally | High | Clean-tree preflight before auto-commit; runtime artifacts are ignored. |
| Tests pass but feature is incomplete | Medium | Strong final reviewer compares the implementation to the source document and plan. |

## Acceptance

- Unit tests exercise scheduling, configuration, retry routing, and Codex argument generation.
- A dry run can create a plan/state preview without calling Codex or changing source files.
- An interrupted state can be resumed without losing completed task evidence.
- No code path automatically pushes, merges, deploys, or removes a worktree.
