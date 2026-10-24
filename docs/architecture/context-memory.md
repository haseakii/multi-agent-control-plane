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

### Current runtime implementation

`ContextBuilder` now runs before the ACP process starts, including on explicit recovery. It
collects the project description, parent objective, dependency summaries/results, completed
child results, prior attempt states/failures, and the workspace metadata available to the
runtime. Storage and artifact reads are provided through `ContextSource`.

`contextRefs` currently selects existing project artifacts by ID or `artifact:<id>`; at most
32 explicit references are accepted. Publish selected files as artifacts first. Small text
artifacts are included (8 KB per artifact, 16 KB total); other materials retain their IDs,
content hashes and omission reasons. Referenced materials from another project or missing
artifacts stop execution before an Agent starts. Accepted project memory is included separately;
project descriptions are not treated as accepted memory decisions.

The versioned package and its hash are saved in an `execution.context.prepared` audit event
using the existing event store. The same JSON is appended to the initial ACP prompt as
reference data, with `acceptedMemory` explicitly identified as operator-reviewed project
guidance (it grants no tool permissions). The full assignment objective remains in its durable assignment record.
Later routed messages and operator instructions keep their separate delivery records.
The context snapshot itself uses no new SQL table; a runtime test checks input delivery and exact event persistence
after SQLite reopen. The console displays this snapshot under “本次执行依据”.

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

### Current curation workflow

Migration `0009_project_memory` adds immutable-content proposals, their review state, and
the local search index. The console supports facts, constraints, decisions and issues;
operators may accept/reject a proposal, archive accepted memory, or propose a correction.
Accepting a correction atomically archives its predecessor. Neither archived nor rejected
records are deleted. Each record retains task/artifact provenance, proposer and reviewer;
the service validates all references within the project and writes an audit event in the
same transaction. HTTP callers cannot supply their own actor or accepted state.

`ProjectMemoryService` uses a storage port. The local operator API and scoped Fleet MCP
tools can submit proposals. `control_propose_memory` requires `memory.propose`, stamps the
active Agent and task at the server, and validates evidence artifacts against the execution's
artifact scope. Agents cannot provide an accepted status, reviewer or source task. The
console shows the proposing Agent and refreshes when memory events appear. Only the local
operator can accept/reject/archive records in this increment; arbitrary Agent reports are
never promoted automatically.

`control_search_knowledge` requires the separate `knowledge.read` scope. It searches accepted
memory and published text/JSON artifact excerpts across the current project, including other
tasks. This is explicitly broader than task-scoped artifact reads and is opt-in in Agent
settings. Reading complete artifacts still requires the existing artifact scope and checks.
Search results carry source IDs, excerpts and coverage limits, not new tool permissions.
Both tools work for Workers without Boss privileges and remain subject to project policy.
New scopes are not automatically granted to existing registrations; scope changes expose
new tools in subsequent execution sessions. The existing memory schema already supports
Agent actors, so this adds no migration or rewrite of historical records.

Before each execution, `ContextBuilder` includes accepted records, prioritizing constraints,
then decisions, facts and issues, newest first within each kind. It includes complete records
up to 16 records / 24 KB; omitted IDs are listed in the context notes. The exact content and
provenance are frozen in that execution's audit snapshot. A later acceptance or correction
affects subsequent executions, not an already-running prompt or its historical snapshot.

Operator endpoints:
- `GET/POST /api/projects/:id/memory`
- `POST /api/projects/:id/memory/:memoryId/review` with `accept`, `reject`, or `archive`
- `GET /api/projects/:id/knowledge?query=...` with optional `source`, `kind`, `taskId`, `since`, `limit`

## Search
V0:
- SQLite FTS5 over project memory and text artifacts
- metadata filters by project/task/kind/time

The SQLite implementation uses FTS5 trigram matching for literal phrases, including Chinese;
one- and two-character queries use a substring fallback. Search returns only accepted memory
and published text/JSON artifacts. Proposals, rejected and archived records remain visible
in the curation panel. Memory indexing follows transactional insert/update/delete triggers;
new artifact publication indexes its first 256 KiB in the metadata transaction. Truncated
results say so and retain the complete artifact link.

For existing databases, each search backfills at most 32 previously unindexed text artifacts
of at most 256 KiB. Legacy larger blobs are not loaded merely to search them; the API/UI
reports the number still unindexed. Search results therefore do not claim exhaustive coverage
of all legacy large files. `ContextSearchIndex` keeps query access replaceable.

Not V0:
- mandatory vector database
- autonomous embedding pipeline

A vector-memory provider can be added later behind the same query interface.

## Summaries
Long task histories may produce explicit immutable summary artifacts. Summaries are references with provenance, not destructive rewrites of source events.
