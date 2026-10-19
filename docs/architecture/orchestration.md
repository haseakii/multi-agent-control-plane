# Orchestration

## Boss model
Boss is not a special vendor integration. It is a registered agent selected for a project/run and granted orchestration capabilities.

```ts
type BossPolicy = {
  agentId: string;
  allowedOperations: (
    | "agents.discover"
    | "tasks.create"
    | "tasks.delegate"
    | "messages.send"
    | "tasks.cancel"
    | "artifacts.read"
    | "artifacts.publish"
    | "approvals.request"
  )[];
  maxWorkers: number;
  maxTaskDepth: number;
};
```

Policy still has final authority over filesystem, shell, network, Git, package installation, and other dangerous actions.

## Control Bridge
An ACP agent cannot be assumed to have a native API for controlling the control plane. V0 therefore defines pluggable bridges.

Priority:
1. **MCP bridge** — preferred. Control plane exposes orchestration operations as MCP tools.
2. **CLI bridge** — `agentctl` exposes the same operations for agents with shell access.
3. **Structured-command bridge** — agent emits validated orchestration commands in a constrained schema.
4. **none** — agent can be a worker but cannot be Boss.

The semantic API is identical across bridges.

## Boss operations
Minimum V0 operations:
- `discover_agents(filter)`
- `get_agent(agentId)`
- `create_task(input)`
- `delegate_task(taskId, selector)`
- `get_task(taskId)`
- `wait_task(taskId)`
- `send_message(input)`
- `get_artifact(id)`
- `publish_artifact(input)`
- `request_approval(input)`
- `cancel_task(taskId)`

## Dynamic roles
Role is assignment-local text/metadata. The Boss may create a role at runtime, for example:
- "concurrency safety reviewer"
- "Unity validation operator"
- "API compatibility researcher"

Agent selection is capability-driven plus policy constraints. The framework never hard-codes "Gemini = architect" or equivalent mappings.

## Task graphs
Tasks may form a DAG through parent/dependency relations. The framework provides graph execution primitives but does not prescribe phases such as research/design/implementation/review.

Example:
```text
root
 |-- task A ----\
 |              +--> task C --> task E
 |-- task B ----/              /
 +--> task D -----------------/
```

## Failure and retry
Retry creates a new execution attempt. A failed ACP Conversation is not rewritten into success. The Task preserves all attempts for audit.

Retry policy must distinguish:
- transient runner/process failure
- protocol failure
- worker-declared failure
- policy denial
- human rejection
- deterministic task failure

## Cancellation
Cancellation propagates from parent to children only when the parent policy says so. A Boss may cancel one worker without destroying sibling tasks.
