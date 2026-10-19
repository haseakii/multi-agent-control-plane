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
Owns durable truth: projects, agents, capabilities, tasks, assignments, messages, artifacts, approvals, runner state, audit events, and policy decisions.

### Runner
Owns process spawn/termination, OS process status, and stdout/stderr. LocalRunner is an execution convenience, not an OS security sandbox.

### ACP runtime
Connects to the Runner-provided process transport and owns ACP initialization, authentication-flow handling, session creation/resume, prompt streaming, updates, and cancellation. It does not own OS process creation or termination.

### Agent
Owns its internal model/tool loop. The control plane treats vendor-specific internals as opaque unless exposed through capabilities or events. Not every internal tool call or side effect is necessarily visible to the ACP host.

### Boss
A normal registered agent granted bounded orchestration capabilities. Boss accesses control-plane operations through a scoped Control Bridge, preferably MCP.

### Worker
Any registered agent receiving a task assignment. Worker is not a permanent role. A worker may execute tasks without a bridge; initiating routed messages requires the separate `agent.messaging` scope.

## Protocol layering

```text
ACP : Host <-> Agent lifecycle and interaction
MCP : Agent -> Control Plane / external tools
A2A : optional future native Agent <-> Agent transport
```

For supported ACP agents, the host attaches the Fleet MCP server using session-level `mcpServers` configuration when creating and resuming sessions. Bridge calls are authenticated, scope-checked, policy-evaluated, and audited. Agents that cannot consume the bridge need a supported CLI/structured adapter or operate without bridge tools.

V0 routes all logical agent-to-agent communication through the control plane even when both endpoints are ACP agents.

## Policy enforcement boundary
The Policy Engine can enforce operations mediated by the control plane, workspace/Git services, and ACP permission requests that are actually surfaced by the agent. It cannot guarantee interception of opaque agent-owned shell/filesystem/network tools. LocalRunner and Git worktrees do not provide strict isolation; the system must label enforcement as enforced, cooperative, or unavailable, and refuse tasks requiring strict enforcement when the selected boundary cannot provide it.

## Key invariants
- Task != Conversation.
- Agent != Role.
- Message != Artifact.
- Authentication != Authorization.
- Boss authority is bounded by Policy and bridge scopes.
- Runner location is not part of Agent identity.
