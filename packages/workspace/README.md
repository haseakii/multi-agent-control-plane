# workspace

Policy-gated local workspace providers for V0.

- `LocalDirectoryWorkspaceProvider` validates and persists an existing local directory.
- `GitWorktreeWorkspaceProvider` creates per-task Git worktrees and exposes mediated merge/push operations.
- Git commands use argument arrays with `shell: false`; there is no string interpolation into a shell.
- merge/push always pass through the Policy Gate.
- separate worktrees prevent normal Git working-copy collisions between concurrent write tasks.

Local directories and Git worktrees are organizational boundaries, not OS security sandboxes. They report an unavailable isolation enforcement boundary; callers that require strict isolation fail closed.
