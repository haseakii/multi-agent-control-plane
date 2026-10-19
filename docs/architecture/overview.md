# Architecture Overview

## Mission
Provide a local-first control plane that can register, run, coordinate, observe, and govern heterogeneous ACP-compatible agents without assigning fixed vendor roles.

## Non-goals for V0
- Building a new LLM.
- Replacing ACP.
- Replacing MCP or A2A.
- Hiding every provider behind a single fake model API.
- Distributed consensus, Kubernetes scheduling, or cloud-first tenancy.
- Autonomous long-term learning/routing optimization.

## Logical architecture

```text
Clients
  |-- Web
  |-- CLI
  |-- REST/WebSocket
  v
+--------------------------------------------------+
| Control Plane                                    |
|                                                  |
| Agent Registry ---- Capability Index             |
|      |                                           |
| Boss Runtime ----- Task Engine ---- Context      |
|      |                |              |           |
| Message Router -------+---------- Artifact Store |
|      |                               |           |
| Policy/Approval ----- Event Log ---- Storage     |
|      |                                           |
| Runner Manager ---- Workspace Manager            |
+--------------------------+-----------------------+
                           |
                     ACP Client Runtime
                           |
                 +---------+----------+
                 |                    |
             Local Runner         Future Runners
                 |              Docker/SSH/Remote
          stdio ACP agents
```

## Separation of concerns

### Control plane
Owns durable truth: projects, agents, capabilities, tasks, assignments, messages, artifacts, approvals, runner state, audit events.

### ACP runtime
Owns protocol lifecycle: process startup, initialize, authentication state, session creation/resume, prompt streaming, updates, cancellation, permission requests.

### Agent
Owns its internal model/tool loop. The control plane treats vendor-specific internals as opaque unless exposed through capabilities or events.

### Boss
A normal registered agent granted orchestration capabilities. Boss accesses control-plane operations through a Control Bridge, preferably MCP.

### Worker
Any registered agent receiving a task assignment. Worker is not a permanent role.

## Protocol layering

```text
ACP : Host <-> Agent lifecycle and interaction
MCP : Agent -> Control Plane / external tools
A2A : optional future native Agent <-> Agent transport
```

V0 routes all logical agent-to-agent communication through the control plane even when both endpoints are ACP agents.

## Key invariants
- Task != Conversation.
- Agent != Role.
- Message != Artifact.
- Authentication != Authorization.
- Boss authority is bounded by Policy.
- Runner location is not part of Agent identity.
