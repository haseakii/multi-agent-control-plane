# Durable task instructions (C6)

The local operator may add bounded supplemental text to an already executing task. TaskInstruction is separate from AgentMessage and ACP conversation state. The local-owner API records actor user/local-operator as ingress provenance, not authenticated human identity. Same-user local processes are not isolated by this API.

POST /api/tasks/:id/instructions accepts only content (trimmed, 1..4000 characters) and idempotencyKey (1..128 characters). GET returns the history and current canSubmit/reason. No actor, approval decision, task state or resume flag is accepted. Suspected credentials are rejected before input/audit persistence. The queue is limited to 32 inputs and 32000 UTF-8 content bytes per task.

Submission and its content-free audit reference commit atomically. Identical retries return the durable receipt even after acceptance closes; changed content with the same key conflicts. UI retries after an uncertain network outcome retain the original request key and freeze its body. Component state is scoped to a project/task. A new submission requires current server eligibility and is always rechecked server-side.

States: queued means persisted and awaiting a safe prompt boundary; claimed means reserved for one execution attempt; delivered means the ACP round containing the input ended. None implies understanding, successful tools, or external side effects. Inputs never preempt an ACP prompt, replace an approval decision, or automatically resume/cancel/assign tasks. Inputs arriving while a task waits for children remain queued until the continuation boundary. No new input is accepted after final publication begins.

The queue checks the live execution owner within claim/acknowledgment transactions. A cancelled task retains history without restarting. Explicit recovery may reclaim an unacknowledged input for a new attempt. Acknowledged inputs are replayed as labeled recovery context when artifact publication or the process fails, without a second acknowledgment or silently replaying the old task. Opaque agent-owned tools remain cooperative or unavailable according to the real boundary.

SQLite migration 0007_task_instructions.sql adds the eighth migration. Forward migration from a real seven-migration database preserves previous task/event payloads. Consistent snapshots include the new table; inspection validates task/project/attempt relationships. The existing exact migration-hash compatibility check remains authoritative; this does not promise restoring a C5 backup directly into C6 or downgrading C6 data. Work on a separate copy and preserve previous program/data/consistent backups.

Validation uses deterministic runtime gates, SQLite reopen/backup tests, and an actual inert ACP child process. It makes no provider/model call and does not establish a real-model collaboration acceptance.
