# web

React/Vite local control-center UI. Run the server and `pnpm dev:web` from the
repository root, then open the Vite URL.

## Run a goal

1. Create a project, or choose an existing project.
2. Register an ACP agent with its executable and arguments. Enable Boss capability
   only for agents that support the scoped Fleet MCP bridge.
3. Probe the agent and complete any required agent-managed authentication.
4. Select an eligible Boss for the active project.
5. Enter a goal objective, optionally give it a title, and submit it.
6. Follow the task state, timeline and routed messages. The page refreshes its
   snapshot every two seconds; execution does not depend on keeping the page open.
7. Review each pending approval's requester, action, resource and enforcement
   mode before choosing **Approve** or **Reject**. The UI never auto-approves.
8. Open **View result** when a task publishes an artifact. Text/JSON artifacts up
   to 64 KiB can be previewed; use **Download result** to retrieve larger or
   non-text outputs.

Tasks, timeline, messages, approvals, artifacts and workspaces are scoped to the
active project. The agent registry and runners are shared. Failed submissions
preserve the draft for an explicit retry; automatic refresh never resubmits work.

LocalRunner is not an OS sandbox. An approval's enforcement mode describes the
actual execution boundary, not a promise that arbitrary agent-owned tools are
intercepted.

Demo mode seeds illustrative metadata, not executable agents or artifact bytes.
Register a runnable ACP agent to produce actual results.

## Verification

- `pnpm --filter @control-plane/web typecheck`
- `pnpm --filter @control-plane/web build`
- `pnpm test:e2e` from the repository root

The browser suite includes the real demo snapshot smoke test and deterministic
mocked API responses for fresh projects, Boss selection, asynchronous results,
explicit approval decisions, submission retries and project switching. Server
and process acceptance tests independently exercise actual orchestration.
