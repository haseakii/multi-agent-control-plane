# V0 delivery audit — R6.1, 2026-10-22

The agreed V0 delivery scope is complete with the evidence and compatibility limits below.
The operator authorized the remaining Phase 0 installation check, which passed on the
prepared clean staging tree using pnpm 10.11.0, offline and with a frozen lockfile.

## Authoritative evidence

- **Current program:** R6.1's 354 program/runtime file hashes equal the verified R6 program.
  Only the operator instructions and delivery metadata changed. Evidence is
  `.run/collaboration-integration-20261022/delivery-r6-1/Control-Plane-V0-Progress-R6.1-20261022/DELIVERY.json`.
- **Full local baseline:** the repository's actual pnpm 10.11.0 `lint`, `typecheck`, `test`
  and `build` commands all passed; 425 tests passed, zero failed/skipped. See
  `.run/collaboration-integration-20261022/r6-pnpm-baseline/progress.json` and `tests.json`.
- **Fresh dependency installation:** all 13 workspace projects installed successfully;
  250 cached packages reused, zero downloads. The staging lockfile and recorded source
  dependency metadata hashes are unchanged. See `offline-install-check/RESULT.json`
  and `install.log` under the same evidence root. This verifies installation separately
  from the existing R6 source quality baseline; it does not claim another full test run.
- **Current standalone workflow:** actual `start.cmd`, bundled Node, two independent
  synthetic ACP child processes, delegation/result/final response, memory inclusion,
  shutdown with an active SSE connection and restart without task replay all passed.
  See `delivery-r6-1/packaged-mainline-r3/mainline.json` under the same evidence root.
  The verification driver exited successfully and its owned service stopped. Earlier
  failed invocations were harness failures before application startup; their logs remain.
- **Real pair:** `real-pair/finalization.json` records the completed Codex/Antigravity
  arithmetic mainline and preserved task/message/artifact history. It used 3 original plus
  1 approved summary ACP prompt. It is historical real-adapter evidence, not a new R6.1
  provider run. No additional real prompts are authorized or were used here.
- **Browser:** R5 packaged create/edit/list and delete-preview cancellation, then R6
  packaged cross-tab SSE updates were observed using the browser. This is targeted UI
  evidence, not a claim that the whole Playwright suite or physical Ctrl+C was executed.

## Original must-have checklist

| Item from `architecture/v0-scope.md` | Current proof and boundary |
| --- | --- |
| AgentDefinition CRUD | Agent-control API/UI, `agent-control.test.ts` (11 passing cases); referenced definitions retain history |
| stdio ACP LocalRunner | Runner and ACP runtime checks, plus independent bundled ACP child processes |
| Runtime/auth readiness and unknown states | Registry, negotiation, process-control and capability selector checks; real pair native authorization record |
| Capability registry/search | `capability-selector.test.ts`, real Boss discovery and audited synthetic discovery |
| Selectable Boss / explicit scopes | Agent control, Fleet gateway and session-attachment checks; role is not a vendor constant |
| Fleet MCP attachment on creation/resume | `session-attachment.test.ts` (11 passing cases), runtime process mainline and recovery |
| Task CRUD/state machine | Task engine plus draft create/edit/start/delete HTTP workflow and title/history preservation |
| Delegation / attempts | Runtime process checks; current packaged Boss/Worker execution and persisted attempts |
| Durable outbox/inbox, idempotency and restart | Message router tests and runtime delivery tests, with durable reopen checks |
| Direct logical Worker A → B | Runtime-process and gateway messaging-scope checks; actual synthetic ACP processes, without granting Boss tools |
| Conversation/session separate from task | Task/Assignment/Attempt/Conversation schemas, task-engine recovery tests and restart evidence |
| Local artifact store | Content-addressed filesystem/store tests and both real/synthetic result references |
| SQLite persistence / restart | Storage migration tests and current package close/reopen with no execution replay |
| Baseline mediated policy/approval | Policy tests, Fleet authorization and 31 ACP approval-boundary cases |
| Enforcement modes / LocalRunner warning | Core/runtime boundary fields, policy refusal tests and visible workbench/workspace notice |
| Local directory / Git worktrees | Workspace, assignment, review, push and cleanup workflows and migration tests |
| Event/timeline API | Existing event/snapshot reads plus R6 SSE project notices, durable cursor replay and shutdown |
| Minimal web UI | Packaged task-oriented workbench: registry/settings, tasks, timeline, approvals, artifacts and messages |
| Two different ACP agents | Real Codex + Antigravity mainline completed under the explicitly approved 3+1 allowance |

## Demo steps and messaging acceptance

The real-pair record covers demo steps 1–8: configured registrations, native authentication,
Boss selection/scopes, independent ACP sessions and Fleet attachment, submitted goal,
discovery/create/delegate, Worker durable result, and final Boss continuation. Its restart
check covers preserved task/message/artifact history. The current packaged mainline also
covers startup/close/restart and audit records. Pending-delivery recovery and scope refusal
in steps 9–10 are verified by the current deterministic router/runtime/gateway checks;
they were not deliberately forced in the paid arithmetic run.

All four messaging criteria have deterministic runtime evidence: messaging-only Worker
request, response without Boss privilege, assigned execution with no initiating bridge,
and idempotency/restart recovery. Broader real-provider Worker-to-Worker and permission
compatibility remain optional further evidence subject to a new explicit allowance, not
an implied authorization to consume more prompts.

## Architecture and development constraints

The current domain schemas keep Agent, role, durable task, Assignment, Attempt and
Conversation distinct. Generic eligibility/scopes select a Boss; ACP is the primary
transport. Logical control-plane messages use the audited router. Native authentication
remains Agent-owned, large outputs use artifact references, and policy decisions carry
their actual enforcement boundary. LocalRunner/worktrees are not described as OS sandboxes.

Task-engine repositories, message storage, artifact blobs and workspace adapters expose
interfaces; SQLite/filesystem implementations do not introduce OpenHands, Redis, Kafka,
Kubernetes or a mandatory cloud dependency. Current domain-source inspection found no UI
imports or vendor-named role logic. Strict TypeScript and the public runtime schemas were
checked by the standard baseline. All current migration tests passed. Draft management and
SSE introduced no new durable fields/tables; their reopen behavior is checked against the
existing schemas. Permission tests preserve explicit dangerous-action decisions rather
than silently auto-approving.

## Completed gates and evidence limits

| Gate | Status |
| --- | --- |
| `pnpm lint`, `typecheck`, `test`, `build` | Passed on R6; R6.1 program matches by hash |
| Fresh locked `pnpm install` | Passed in the authorized isolated directory, offline; 250 reused packages, zero downloads |
| PR CI configuration | Workflow config targets pull requests and uses pnpm 10.11.0 / Node 22; no fresh hosted run claimed |
| Package startup / assets / current synthetic mainline / restart | Passed through actual R6.1 `start.cmd` |
| Additional real prompts / global installs / original service replacement | None performed |

The installation plan is
`.run/collaboration-integration-20261022/offline-install-check/PLAN.json`.
The staging tree now has its own dependency installation from copied manifests/lockfile.
The command used the existing cache offline and did not target the working source dependency
tree or global configuration. Source manifest, lockfile and installed dependency metadata
hashes remained unchanged. No real Agent prompt was used. The existing R6.1 program/package
is unchanged; these installation records close the remaining local acceptance gate.
