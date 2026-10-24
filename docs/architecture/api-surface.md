# Initial API Surface

This is a semantic API, not a frozen HTTP contract.

## Agent registry
- `POST /agents`
- `GET /agents`
- `GET /agents/:id`
- `PATCH /agents/:id`
- `POST /agents/:id/probe`
- `POST /agents/:id/auth`
- `GET /api/agents/:id/removal`: current blockers, reference counts and definition hash.
- `DELETE /api/agents/:id`: requires `{ confirmedAgentId, definitionHash }` from the preview.

Removal is limited to disabled registrations with no project or historical domain references
and no probe/auth observation in flight. The service rechecks inside a storage transaction;
changed definitions or new references return 409. Used registrations remain available for
history and can be disabled. Removing a registration does not uninstall the Agent, clear its
login, or remove its workspace. Reference queries sit behind `AgentReferenceReader`.

## Product catalog and local entry discovery

The product picker uses `GET /api/agent-catalog` for cached registry metadata and
`POST /api/agent-catalog/refresh` for an explicit request to the fixed official registry.
`POST /api/agent-catalog/discover-local` accepts `{ entryId, directory? }` and returns validated
candidate runtime entries. It matches existing registrations by exact display name or
current-platform executable basename, then checks at most 64 absolute local PATH directories
for that basename and known installed-package locations. An optional absolute local installation
directory is checked at fixed paths (program root/bin, package root/node_modules/lib/node_modules),
without recursive scanning. For npx catalog entries, matching local package manifests (bounded to
128 KiB) supply regular JS bin entrypoints contained in the resolved package directory. The current
Node executable and script path are returned as a candidate; package scripts never run. Package
name/version claims are metadata, not identity verification. Discovery does not execute, install,
authenticate, or import registry arguments/environment values. The UI displays suggested launch
arguments separately for explicit operator selection before registration/probe. Unsupported
package layouts retain manual entry. The vendor-neutral runtime/role contract is unchanged.

## Projects
- `POST /projects`
- `GET /projects/:id`
- `PUT /projects/:id/boss`

The implemented `/api/projects/:id/boss` route accepts `{ agentId: null }` to clear the
project default. Existing task-scoped Boss assignments are not changed by this operation.

## Tasks
- `POST /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/delegate`
- `POST /tasks/:id/cancel`
- `GET /tasks/:id/events`

Operator draft CRUD is available under the implemented `/api` prefix:
`POST /api/projects/:id/tasks`, `GET /api/tasks/:id/record`, `PATCH /api/tasks/:id`,
`DELETE /api/tasks/:id` and `POST /api/tasks/:id/start`. See
[task-record management](task-record-management.md) for version confirmation, draft
eligibility and preservation of execution history.

`POST /api/tasks/:id/start` accepts either the existing `{version, bossAgentId,
workspaceConfirmation?}` contract or `{version, mode: "direct", agentId,
workspaceConfirmation?}`. Direct starts keep the project's Boss unchanged and
persist a Collaborator assignment; they do not grant orchestration permissions.
Retry and follow-up retain this execution role after process restart. Both paths
share draft version checks, workspace confirmation, policy and human review/merge.

## Messages
- `POST /messages`
- `GET /tasks/:id/messages`
- `GET /api/tasks/:id/message-deliveries`: read-only persisted delivery status, recipient-task
  link, timestamps and claim count for messages in this task's scope. This never retries work
  or interprets a saved reply as semantic acknowledgement. The control-center snapshot also
  includes `messageDeliveries`; unavailable receipts remain explicit.

## Artifacts
- `POST /artifacts`
- `GET /artifacts/:id`

## Approvals
- `GET /approvals?state=pending`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/reject`

## Reviewed Git push

- `GET /api/tasks/:id/workspace-pushes`: durable push history.
- `GET /api/tasks/:id/workspace-reviews/:reviewId/push-remotes`: configured remote names for a merged review.
- `POST /api/tasks/:id/workspace-reviews/:reviewId/pushes`: prepare with `{ remote }`.
- `POST /api/tasks/:id/workspace-pushes/:pushId/decision`: `{ state: "approved" | "rejected" }`.
- `POST /api/tasks/:id/workspace-pushes/:pushId/execute`: `{ confirmedCommit, confirmedDestinationHash }`.
- `POST /api/tasks/:id/workspace-pushes/:pushId/check`: inspect an uncertain remote result without resending the push.

Project policy `gitPush` defaults to `deny`; `ask` enables the explicit approval flow.
Requests bind the reviewed merge commit, resolved destination and target branch. Execution
rechecks policy, approval and source identity at the control-plane Git boundary. Failed or
interrupted pushes are not automatically retried. Migration `0012_workspace_pushes` preserves
the request and approval relationship across restart.

## Workspace cleanup

- `GET /api/tasks/:id/workspace-cleanup`: eligibility, blockers, exact plan and confirmation hash.
- `POST /api/tasks/:id/workspace-cleanup`: `{ confirmedWorkspaceId, confirmationHash }` from a fresh preview.
- `POST /api/tasks/:id/workspace-cleanup/check`: the saved confirmation; reconcile an interrupted cleanup without repeating directory deletion.

Cleanup retains task/workspace bindings, messages, reviews and artifacts. Shared/source
directories are excluded; local task directories must be empty, and Git content must already
be preserved in merged history. Operations are serialized with project review/merge/push and
exclude active execution. See [workspace lifecycle](runners-workspaces.md) for preservation
rules, retained branches and the external-writer boundary. A task that entered cleanup cannot
resume using that assignment directory.

## Realtime
`GET /api/projects/:id/events/stream` provides an SSE stream for durable project events:
- task transitions
- assignment lifecycle
- agent events
- approvals
- messages
- runner state
- policy enforcement mode and decision events

On a new connection, `ready` establishes the current cursor; historical events are already
available through the snapshot/task-event APIs. Reconnecting with `Last-Event-ID` (or the
same opaque cursor in `?after=`) replays subsequent events from the durable audit log.
`control-event` carries only `id`, `projectId`, optional `taskId`, `type`, and `occurredAt`;
full details and artifact content stay in the existing read APIs. Event IDs in the SSE
protocol are URI-encoded opaque cursors. Do not decode/rebuild them in the client.

A missing cursor emits `reset` so the client reloads its snapshot. Notifications can repeat
across reconnects; receiving one is an invalidation hint, never authority to repeat an
Agent operation. The server reads each subscribed project's audit log every 500 ms, emits
up to 100 events per subscriber per pass, sends heartbeat comments every 15 seconds and
limits active subscribers to 16. Slow connections are ended so they can resume; shutdown
ends streams explicitly. The same local-host/origin checks apply as to other APIs.

The web console coalesces event notifications before reloading durable state. A healthy
stream also reconciles non-audited/global readiness state every 15 seconds; connection
failure falls back to two-second snapshot refresh while EventSource reconnects. Watching
or reconnecting never starts an Agent, creates tasks, or retries deliveries. The original
WebSocket alternative is not needed because the SSE transport is implemented.

## Fleet MCP surface

Tools are exposed per session according to bridge scopes, active project/task, and policy. Configured scopes are an upper bound, not an authorization grant.

Knowledge and memory scopes (available independently to Boss and Worker):
- `control_search_knowledge` requires `knowledge.read`: accepted memory and published text artifact excerpts across the active project.
- `control_propose_memory` requires `memory.propose`: immutable proposal with server-bound Agent/task identity and scoped evidence artifacts, pending human review.

The console's Agent settings can edit collaboration scopes through `PATCH /api/agents/:id`.
Agent views include `definitionHash`, a SHA-256 revision of the registered definition
(connection observations do not change it). Editors send this value as optional
`expectedDefinitionHash` in the PATCH body. A stale revision returns HTTP 409 with
`code: AGENT_CONFIGURATION_CHANGED` before any write. Existing clients omitting the
precondition retain their current behavior. No new durable state or migration is needed.
The workbench preserves the editor draft on conflict, reloads the latest definition on
request, and restores only fields actually edited against the original base. Fields
changed on both sides are identified for review before the next explicit save.
No Agent-side memory acceptance tool is exposed.

Boss orchestration scope:
- `control_discover_agents`
- `control_get_agent`
- `control_create_task`
- `control_delegate_task`
- `control_get_task`
- `control_wait_task`
- `control_request_approval`
- `control_cancel_task`

`control_discover_agents` accepts an empty argument object for initial discovery. With
no capability filters it returns eligible candidates and their registered capabilities;
exact/prefix/custom filters narrow that set. The default limit is 50, maximum 100.
Disabled Agents and Agents whose observed runtime/auth state does not meet discovery
requirements remain excluded. Capability metadata is not a grant or execution guarantee.

Messaging scope:
- `control_send_message`

Artifact scopes:
- `control_publish_artifact`
- `control_get_artifact`

All bridge operations call the same application services as HTTP/API clients and enforce the same policy. The server must bind calls to the authenticated agent/session rather than trusting a caller-supplied agent ID.

## Web conversation send recovery

Initial sends retain a stable project ID, optional draft ID, creation key and
original creation objective in tab session storage. Recovered projects must still
match the selected directory and execution mode. The browser does not persist
directory validation or execution confirmation tokens.

`POST /api/projects/:id/tasks` optionally accepts `idempotencyKey` (1–128
characters). The service records a project-scoped request hash in the existing
audit event store and returns the same task on replay, including after SQLite
reopen. A key reused with different creation input is rejected; edits use the
existing version-checked task update route. The task and creation receipt are
committed together. Calls without a key retain their previous behavior.
Recovered drafts that have entered execution are opened without another start.

The local-owner web API exposes `GET /api/tasks/:id/chat-receipts/:key` to look up a
previous `POST /api/tasks/:id/chat` submission. Both path values are bounded to
128 characters. The result is `missing`, `instruction` with its durable record,
or `followup` with the linked task. Reading a receipt never queues input, starts
an Agent, confirms directory access, or merges files. Keys are scoped to the
original task, including when later conversation rounds already exist.

The workbench retains the pending task ID, normalized text, and idempotency key
in tab session storage, with a current-page fallback if storage is unavailable.
After an uncertain send, resending the same text first reads that receipt. An
accepted receipt clears the pending send without another POST; a missing receipt
reuses the original key and follows the normal directory confirmation flow.
New text is a new submission. Confirmation tokens are never stored in this draft.

## External client MCP

The external `client-stdio-main.js --connection PRIVATE_FILE` service exposes nine validated tools:
`collaboration_list_projects`, `collaboration_list_agents`, `collaboration_list_tasks`,
`collaboration_submit_task`, `collaboration_get_task`, `collaboration_continue_task`,
`collaboration_cancel_task`, `collaboration_get_artifact`, and `collaboration_prepare_review`.
It forwards requests to the loopback-only `POST /internal/client/tool` gateway using a distinct
client credential. The engine hashes credentials, applies explicit project and tool grants,
re-evaluates project policy, and records calls under `mcp-client:<id>`. It does not accept the
internal Fleet session token as external client identity. No review approval, merge or push tool
is exposed.

Submit/continue accept durable idempotency keys. Get-task takes an event cursor and a bounded
long poll (up to 30 seconds); get-artifact checks the content hash and returns at most 16,000
characters per page. Process/usage records and artifact text are untrusted task data. Follow-up
returns the new task ID, preserves earlier context and carries unmerged code into a separate
assignment workspace; fixed reviews include the cumulative change against the source base.
