# Operator task records

The operator can prepare a durable goal before selecting or authenticating an Agent.
Saving a draft neither creates an assignment nor starts a process. It also works before
the execution gateway is available. Drafts appear in the ordinary project task list.

- `POST /api/projects/:id/tasks`: create a root draft with `title` (optional) and `objective`.
- `GET /api/tasks/:id/record`: read the task, its content-derived version and edit/delete eligibility.
- `PATCH /api/tasks/:id`: update `title` and/or `objective`, supplying the observed `version`.
- `DELETE /api/tasks/:id`: delete an eligible draft, supplying the observed `version`.
- `POST /api/tasks/:id/start`: start the existing root draft, supplying `version`, `bossAgentId`
  and, for a bound directory, the existing `workspaceConfirmation` contract.

All inputs have strict runtime schemas. The version is recomputed at mutation time inside
the storage transaction. Starting also rechecks the selected Boss, workspace, bridge
eligibility and execution capacity. It transitions the same durable task and creates its
first Assignment/ExecutionAttempt; a repeated start cannot create another execution.

Objectives can be edited only on unassigned root drafts. Once execution has begun, the
original objective and assignment remain intact; operators can change the display title
and use the existing task-instruction queue for additional requirements. Title changes
do not rewrite previously captured execution-context artifacts.

Deletion is limited to unexecuted root drafts without task/dependency, assignment,
conversation, message, artifact, approval, instruction, memory or workspace-history
references. Eligibility is checked again when deleting. No cascade, directory removal,
branch deletion, or Agent invocation is performed. Creation/edit/deletion audit events
remain in project history, including the ID of a deleted draft. Referenced and executed
tasks retain their durable history; cancellation and workspace cleanup remain separate
operations. This is the lifecycle constraint on task CRUD, not a history-purge API.

The UI offers “保存草稿”, “编辑草稿”, “启动任务”, and “删除草稿”. Starting and deleting
show the reviewed task and require explicit confirmation. A missing Boss does not block
draft saving. Form errors preserve the operator's edits; a stale version requires review
of the current record before another mutation. Closing a dialog returns focus to its trigger.

No table, persisted field or state enum was added: drafts, titles, objectives and audit
events use the existing schema. Two deterministic HTTP workflows in
`apps/server/src/task-records.test.ts` cover CRUD, stale/reference refusal, restart
persistence, a single mocked ACP execution, and retention of execution history.
