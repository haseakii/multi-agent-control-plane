# Runners and Workspaces

## Runner abstraction
A Runner is an execution location, not an agent.

```ts
interface Runner {
  id: string;
  probe(): Promise<RunnerStatus>;
  spawn(spec: ProcessSpec): Promise<ProcessHandle>;
  stop(handle: ProcessHandle): Promise<void>;
  status(handle: ProcessHandle): Promise<ProcessStatus>;
  logs(handle: ProcessHandle): AsyncIterable<ProcessLog>;
}
```

## V0
Implement `LocalRunner` only, but keep runner identity in process/conversation records.

## Planned runners
- DockerRunner
- SSHRunner
- RemoteRunner
- KubernetesRunner (only if later justified)

## Runner selection
AgentDefinition may request capabilities/labels, e.g.:
```yaml
runnerSelector:
  os: windows
  labels:
    - unity
    - gui
```

This allows a future Windows runner for GUI/Unity and Linux runners for normal coding agents.

## Workspace
Workspace is the filesystem boundary visible to an assignment.

V0 providers:
- LocalDirectoryWorkspace
- GitWorktreeWorkspace

## Git worktree lifecycle
Recommended write-task path:
1. resolve base ref
2. create task branch/worktree
3. bind assignment to that workspace
4. agent modifies/tests
5. publish diff/test artifacts
6. review/approval
7. merge/cherry-pick is a separate policy-controlled operation
8. cleanup when safe

Multiple write agents should not share one worktree unless explicitly requested.

## Read-only review
A reviewer may receive:
- read-only workspace
- diff/patch artifact only
- repository snapshot

The framework chooses based on assignment requirements and policy.
