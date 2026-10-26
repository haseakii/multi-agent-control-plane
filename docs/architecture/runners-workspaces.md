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

### Runtime integration

Each assignment now has a durable `assignment_workspaces` binding, separate from its ACP
session and execution attempts. New managed projects default to `task-local`: every new
assignment receives an empty directory. Existing-directory projects default to `git-worktree`:
the source must be a Git repository with a commit, and each assignment receives a new branch
from the resolved source HEAD. Uncommitted source edits are not copied. Both the process cwd
and ACP session cwd are the assigned directory; omit Agent-level cwd for isolated modes.

The operator can explicitly select `shared-directory` in the console. Workspace mode changes
are refused while project executions are active. Retrying an assignment reuses its saved
directory and branch. Migration 0008 preserves historical assignment-to-source bindings and
marks older project configurations as `unconfigured`, requiring a mode choice before new work.
It does not move or delete existing files. A legacy shared assignment must be recovered while
other project tasks are stopped unless sharing is explicitly selected.

On successful Git-worktree execution, the runtime publishes the Agent report, a snapshot
diff against the recorded base (when nonempty), and a workspace status/commit summary. A
temporary Git index includes tracked and non-ignored untracked files without changing the
real index. Ignored files and submodule working-tree contents are not included.
Directories and branches remain available after completion. Automatic merge, push and cleanup
are not part of this runtime path. Workspace mode and actual task directory/branch are visible
in the console; no OS isolation is claimed.

### Operator review and local merge

Migration `0010_workspace_reviews` persists immutable review metadata, artifact references,
approval binding and merge state. After project executions stop, the operator can generate
a review from a terminal task's Git workspace. A private index captures the task tree;
Git `merge-tree --write-tree` prepares its integration with the source project's current
branch without checking out or moving that branch. The displayed patch is the actual
proposed change to that target revision, including compatible changes already made there.
This requires Git 2.38 or newer; conflicts require resolution and a fresh review.

The console exposes the file list, full patch, manifest, explicit approve/reject controls,
and a separate confirmed local merge. Project policy can deny `git.merge` or ask for approval of
the exact review, target revision and merge commit. Applying re-evaluates policy, verifies
the saved approval, rechecks bound directories and requires the same clean target branch
and HEAD before fast-forwarding to the prepared merge commit. Later task edits are excluded.
No push occurs. A durable applying record can be reconciled after restart if HEAD already
equals the approved merge commit. Git and SQLite are not one atomic transaction.

The runtime serializes review/merge operations per project and excludes concurrent project
execution. This is control-plane enforcement, not exclusion of external Git clients or opaque
Agent tools; avoid external repository writes during merge. Prepared objects are retained
under `refs/control-plane/reviews/`. Worktrees, task branches and review refs are retained until
explicit operator cleanup; more granular resource/Agent-specific rules remain open. Repository Git hooks are not
run by the prepared-commit fast-forward operation. SQLite backups preserve review metadata
and artifacts, but do not back up Git object databases or working files.

Routes: `GET/POST /api/tasks/:id/workspace-reviews`,
`POST /api/tasks/:id/workspace-reviews/:reviewId/decision`, and
`POST /api/tasks/:id/workspace-reviews/:reviewId/merge`.

### Operator push after local merge

Migration `0012_workspace_pushes` persists push requests, bound approval, execution state and
outcome. It preserves existing policies and defaults the new `gitPush` rule to `deny`.
Operators can enable `ask` in project policy, select a configured remote, generate a request,
review its concrete address/branch/commit, approve it, then separately confirm execution.
Preparation reads local Git configuration only. Execution sends the exact reviewed merge
commit and its ancestor history; later local commits are excluded. Tags, submodule pushes
and force pushes are not requested. Git retains its normal fast-forward checks and hooks.

Only one effective push URL is supported per selected remote. Embedded HTTPS credentials,
URL passwords and query strings are refused; authentication remains with local Git.
Before execution, the runtime validates the registered project directory, re-resolves the
destination, compares its hash, and re-evaluates policy and the exact saved approval.
An external Git client or hook is outside the control plane's exclusion guarantee.

Git and SQLite cannot commit atomically. A saved `pushing`/`failed` request is never resent
automatically: the operator can explicitly check whether the remote branch points to the
approved commit. A successful check records `pushed`; otherwise the request remains failed
and the operator may inspect remote history before generating a new request. This check
does not infer success merely because the local process exited or the service restarted.
Normal successful `git push` completion is saved with an audit event. Git commands that
contact a remote have a 60-second timeout and terminal credential prompts disabled.

Routes: `GET /api/tasks/:id/workspace-reviews/:reviewId/push-remotes`,
`POST /api/tasks/:id/workspace-reviews/:reviewId/pushes`,
`GET /api/tasks/:id/workspace-pushes`, and
`POST /api/tasks/:id/workspace-pushes/:pushId/{decision,execute,check}`.

### Operator cleanup after delivery

Migration `0013_workspace_cleanups` records the confirmed cleanup plan and its
`removing/completed/failed` state, without deleting workspace bindings or historical domain
records. The console previews the directory, branch disposition and exact review refs;
execution requires confirmation of the workspace ID and a hash of the freshly rechecked plan.
Project review/merge/push/cleanup operations share a lock and exclude active project execution.
Cleanup is an explicit local operator operation, not an Agent-exposed tool.

Only deterministically provisioned assignment paths under the configured managed root qualify.
Source/shared directories are refused. Local task directories must be empty and are removed
with non-recursive `rmdir`. Git worktrees must still belong to the registered repository and
branch. The current tree must already be represented by a merged review reachable from the
source's current HEAD, or be a clean committed tree already in that history. Ignored files,
submodules/nested repositories, sparse/assume-unchanged index flags and independent staged
versions block cleanup. The preview does not read arbitrary ignored file contents.

The adapter removes the checked worktree, deletes its branch only when its exact HEAD is
reachable from the source HEAD, and deletes only exact, merged review refs. Independent task
commit history stays on its retained branch; unmerged or changed review refs stay available.
Ref deletion compares expected object IDs. Historical artifacts remain in the artifact store.
Users must stop external editor/Git writes during cleanup; the control-plane lock is not OS
exclusion. Git and SQLite are not one atomic transaction.

A failed or interrupted cleanup never retries directory deletion on startup. The explicit
check operation requires the saved confirmation, verifies that the directory and worktree
registration are absent, then finishes only the previously confirmed safe ref deletions.
If the directory still exists or refs changed, it leaves the record for manual inspection.
Assignments that entered cleanup cannot resume in place; create a new task to continue.

Routes: `GET/POST /api/tasks/:id/workspace-cleanup` and
`POST /api/tasks/:id/workspace-cleanup/check`.

## Read-only review
A reviewer may receive:
- read-only workspace
- diff/patch artifact only
- repository snapshot

The framework chooses based on assignment requirements and policy, but strict read-only guarantees require an enforced filesystem boundary rather than prompt instructions alone.
