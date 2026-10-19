# Storage and Artifacts

## Local-first storage
V0 defaults to:
- SQLite for metadata/durable state
- local filesystem for artifact blobs
- WAL mode for SQLite
- schema migrations owned by the storage package

## Proposed tables
- projects
- agent_definitions
- agent_capabilities
- boss_assignments
- runners
- workspaces
- tasks
- task_dependencies
- assignments
- conversations
- execution_attempts
- messages
- message_deliveries
- events
- approvals
- memory_entries
- memory_proposals
- artifacts
- artifact_links

Exact columns are implementation work; domain ownership and lifecycle are fixed by this architecture.

## Event log
Important state transitions append an event:
- task created/state changed
- assignment started/finished
- agent process started/stopped
- conversation created/resumed
- message queued/delivered
- artifact published
- approval requested/resolved
- policy denied an action

V0 is not pure event sourcing: current-state tables remain primary for efficient reads. The event log is an audit/reconstruction aid.

## Artifact store
Artifacts are immutable and content-addressed.

Path example:
```text
data/artifacts/sha256/18/18a3...
```

Metadata:
```ts
type Artifact = {
  id: string;
  sha256: string;
  size: number;
  mimeType?: string;
  kind:
    | "text" | "json" | "file" | "diff" | "patch"
    | "log" | "image" | "test-report" | "plan"
    | "directory-manifest";
  creatorAgentId?: string;
  taskId?: string;
  createdAt: string;
};
```

## Immutability
Publishing identical bytes should deduplicate storage. Metadata links may be added without mutating the blob.

## Future backends
Storage interfaces must permit:
- PostgreSQL metadata store
- S3-compatible artifact store
- Redis/NATS delivery adapters

These are explicitly post-V0.
