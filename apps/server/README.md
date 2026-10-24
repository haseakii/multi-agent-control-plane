# Control-plane server

Fastify application host for the local V0 execution path. `src/runtime-composition.ts`
composes SQLite, TaskEngine, LocalRunner, ACP, scoped Fleet MCP, MessageRouter,
approvals, and filesystem artifacts. `src/main.ts` uses the same composition as
the process acceptance tests.

## Run

From the repository root, with Node 22+ and pnpm 10+:

```sh
pnpm install
pnpm build
pnpm --filter @control-plane/server start
```

The default address is `http://127.0.0.1:3000`. `pnpm dev:server` starts the watched
TypeScript entry point after workspace packages have been built.

Configuration:

- `HOST`, `PORT`: listening address; keep the local-only default. This is not a
  multi-user authenticated API. Only loopback Host headers and same-origin browser
  requests are accepted, to reduce DNS-rebinding and cross-site request risks.
  Do not expose it to untrusted networks.
- `CONTROL_PLANE_DB`: SQLite filename, default `.data/control-plane.sqlite`.
- `CONTROL_PLANE_ARTIFACTS`: blob directory, defaults beside the database.
- `CONTROL_PLANE_WORKSPACES`: generated project directories, defaults beside the database.
- `CONTROL_PLANE_DEMO=1`: optional static sample data. It is not a runnable agent setup.

Paths are resolved relative to the server process working directory. Agent-managed
credentials remain with each adapter. Only explicitly allowlisted environment
variables are forwarded to its process. Prefer an absolute executable path;
Windows `.cmd` wrappers and Unix shell scripts are not portable ACP launch commands.

## Minimal workflow

1. `POST /api/projects` with `{ "name": "My project" }`.
2. Register two agents through `POST /api/agents` using the AgentDefinition schema.
   A Boss must have `orchestration.canBeBoss: true`, MCP transport, and the
   `boss.orchestration` scope. Workers need appropriate capability metadata.
3. `POST /api/agents/:id/probe`. Complete each adapter's own authentication flow.
   `unknown` and `not_reported` are not fabricated login success.
4. `PUT /api/projects/:id/boss` with `{ "agentId": "boss-id" }`.
5. `POST /api/projects/:id/goals` with `{ "objective": "Your goal", "title": "Optional label" }`.
   This returns HTTP 202 and durable `task`, `assignment`, and `attempt` objects.
6. Poll `GET /api/tasks/:id` or `GET /api/control-center`. The Boss receives a scoped
   Fleet MCP attachment and can discover ready workers, create tasks, and delegate.
   Each worker executes in a separate ACP process/session. Worker output is stored
   as an artifact and routed back to a continuation of the Boss session.
7. Read `GET /api/artifacts/:id` and `/api/artifacts/:id/content` for final results.

Additional routes:

- `GET /api/projects/:id`
- `GET /api/tasks/:id/events`, `GET /api/tasks/:id/messages`
- `POST /api/tasks/:id/cancel` (cascades to descendants and stops active processes)
- `POST /api/tasks/:id/resume` (explicit retry of a failed/interrupted assignment)
- `GET /api/approvals?state=pending`
- `POST /api/approvals/:id/approve` or `/reject` with `{}`

ACP `allow_once` requests wait for a durable approval decision; they are never
silently approved. The task moves to `waiting_approval`, and the decision releases
the same pending ACP call. Other permission choices are denied by default.

## Recovery and current limits

History, attempts, conversations, messages, approvals, and artifact metadata survive
restart. Unfinished attempts become `interrupted`, stale live-call permissions
expire, and work is not automatically replayed. Explicit resume uses ACP session
load when advertised; otherwise it creates a fresh session. A retry can repeat
agent-owned side effects, so inspect existing work before resuming. Pending result
leases are reclaimed after expiry; a Boss cannot treat an undelivered result as done.
On resume, previously delivered mailbox messages are replayed as recovery context,
including when the adapter cannot reload its former ACP session. This preserves
worker inputs across a failure after delivery but before final artifact publication.

Fleet grants last for the configured execution timeout plus one minute and are
revoked when execution ends. Fleet operations are bound to the active session,
project, and task subtree, and audited. Explicitly routed artifact references can
be read by their receiving task only when it has `artifact.read`. Rejected gateway
calls are logged without bearer tokens; rejections with a known project grant also
produce durable project audit events. V0 caps concurrent executions at 16,
continuations at 32, output at 10 MiB, and process execution at 30 minutes.

Workers receive only their configured non-Boss scopes. `agent.messaging` permits
routed requests/replies without discovery or delegation privileges. An idle
recipient is started in an independent receiving task; an already-active recipient
must have a unique task in the project. Synchronous request cycles are rejected
rather than deadlocked. Workers without a bridge can execute assigned work, but
cannot initiate routed messages. Completion notices are generated by the control
plane, independently of worker bridge privileges.

The snapshot API is polling-based, not a realtime subscription. Generic task CRUD,
arbitrary multi-recipient conversation routing, and stronger OS isolation are not
provided by these minimal goal-execution routes. This is not a claim that every
feature in the broader V0 scope is complete.

LocalRunner and working directories are **not OS security sandboxes**. Fleet policy
is enforced at the Fleet boundary; ACP permission requests are cooperative. Opaque
agent-owned filesystem, shell, and network tools are not intercepted. Use trusted
adapters and a suitable isolated runner if strict execution boundaries are required.

The owner HTTP API has no credentials in this V0. Processes running as the same
OS user can call owner routes, including approvals, directly. Do not run untrusted
adapters under that account: Fleet scope checks are not an authentication boundary
against a hostile same-user process. Browser Origin/Host checks do not change this
trust boundary. No persistent credentials or authentication grants are created here.

Only ACP `end_turn` is treated as a successful turn. Cancellation, refusal, token
limits, turn limits, and unknown stop reasons fail the attempt rather than producing
a falsely completed goal.
