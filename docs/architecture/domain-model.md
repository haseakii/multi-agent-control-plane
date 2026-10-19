# Domain Model

## Core entities

### Project
Boundary for repository/workspace configuration, project memory, policies, task graphs, and default Boss selection.

### AgentDefinition
Persistent configuration for a runnable agent.

```ts
type AgentDefinition = {
  id: string;
  name: string;
  description?: string;
  runtime: AcpRuntimeDefinition;
  capabilities: Capability[];
  permissions: PermissionPolicyRef;
  runnerSelector?: RunnerSelector;
  orchestration: {
    canBeBoss: boolean;
    controlBridge: "mcp" | "cli" | "structured" | "none";
  };
  enabled: boolean;
};
```

No field such as `role: "reviewer"` belongs here.

### Capability
Queryable declaration such as `code.read`, `code.write`, `shell`, `git`, `web`, `computer.gui`, `unity`, or user-defined names.

Capabilities are hints/constraints for routing, not security grants. Security comes from policy.

### BossAssignment
Selects an AgentDefinition as orchestrator for a project/session and grants bounded orchestration operations.

### Task
Durable unit of work. A task can survive process restarts, agent changes, conversation replacement, and model upgrades.

```ts
type TaskState =
  | "draft" | "planning" | "ready" | "running"
  | "waiting" | "waiting_approval" | "blocked"
  | "completed" | "failed" | "cancelled";

type Task = {
  id: string;
  projectId: string;
  parentTaskId?: string;
  title: string;
  objective: string;
  state: TaskState;
  ownerAgentId?: string;
  dependencyIds: string[];
  contextRefs: string[];
  resultArtifactRefs: string[];
  createdAt: string;
  updatedAt: string;
};
```

### Assignment
Binds an agent to a task for a specific execution attempt. Optional `role` is task-scoped free-form semantics such as "concurrency reviewer".

### Conversation
Reference to an ACP execution session. A task may use zero, one, or multiple conversations over time.

### Message
Durable routed envelope between agents/control plane. Messages carry small structured content and artifact references.

### Artifact
Content-addressed immutable payload: diff, patch, file, log, image, report, plan, JSON result, test output.

### Approval
Policy decision record for actions requiring human or external authorization.

### Runner
Execution location abstraction responsible for starting/stopping ACP processes and streaming process I/O.

### Workspace
Bounded filesystem/repository view assigned to work. V0 includes local directories and Git worktrees.

## Important relationships

```text
Project 1---* Task
Task    1---* Assignment
Task    1---* Message
Task    1---* Artifact
Agent   1---* Conversation
Runner  1---* Conversation
Task    *---* Conversation (through execution records)
```
