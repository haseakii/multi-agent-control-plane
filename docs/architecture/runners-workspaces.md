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

Runner owns process creation/termination and exposes a process/transport handle to the ACP runtime. It does not own ACP session semantics.

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
Workspace is the filesystem view assigned to work, not automatically an OS security boundary.

V0 providers:
- LocalDirectoryWorkspace
- GitWorktreeWorkspace

A Git worktree helps isolate concurrent changes and makes review/merge safer, but does not prevent a local process from reading or modifying other files that its OS user can access. LocalRunner runs with its configured OS user's permissions. Do not use it for untrusted agents when strict filesystem/network isolation is required.

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

Control-plane Git operations such as merge/push can be policy-gated. A shell command executed directly inside an opaque agent tool may bypass those gates unless the runtime/sandbox mediates it.

Multiple write agents should not share one worktree unless explicitly requested.

## Read-only review
A reviewer may receive:
- read-only workspace
- diff/patch artifact only
- repository snapshot

The framework chooses based on assignment requirements and policy, but strict read-only guarantees require an enforced filesystem boundary rather than prompt instructions alone.
