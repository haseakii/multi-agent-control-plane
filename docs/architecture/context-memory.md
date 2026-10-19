# Context and Memory

## Objectives
- Keep conversations small enough to remain useful.
- Keep durable project truth independent from model chat history.
- Make context provenance visible.
- Prevent an agent's speculation from silently becoming permanent memory.

## Layers

### Task context
Objective, acceptance criteria, dependencies, active assignment, selected artifacts, and current workspace state.

### Conversation context
ACP session-local context owned by the executing agent. It is disposable.

### Agent private memory
Optional agent-specific durable notes. Never treated as authoritative project truth.

### Project memory
Curated durable facts, constraints, decisions, and known issues.

## Context Builder
Before delegating work, the control plane builds a context package from references rather than dumping all history.

Inputs may include:
- task objective
- parent/dependency summaries
- project constraints
- accepted decisions
- selected files/artifacts
- previous attempt summary
- workspace/commit metadata

The package is recorded so the exact inputs to an execution can be audited.

## Memory proposal flow

```text
Agent observation
      |
      v
Memory Proposal
      |
      +--> rejected
      |
      +--> accepted by policy/Boss/human
                 |
                 v
           Project Memory
```

V0 may use manual or Boss-assisted acceptance. Auto-promotion of arbitrary model output is forbidden.

## Search
V0:
- SQLite FTS5 over project memory and text artifacts
- metadata filters by project/task/kind/time

Not V0:
- mandatory vector database
- autonomous embedding pipeline

A vector-memory provider can be added later behind the same query interface.

## Summaries
Long task histories may produce explicit immutable summary artifacts. Summaries are references with provenance, not destructive rewrites of source events.
