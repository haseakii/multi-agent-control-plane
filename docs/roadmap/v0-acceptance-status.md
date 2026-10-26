# V0 design and implementation review — 2026-10-22

## Daily workbench acceptance — 2026-10-23

The Hermes Web workbench now supports ordinary task input/send, in-flight instructions,
continuous follow-ups, persistent conversation titles, member configuration and native
connection/auth checks, directory selection, artifact viewing and reviewed Git merges.
Daily execution has no three-prompt acceptance cap. Startup publishes the workbench
before checking members; the actual launcher returned in 3.2 seconds with history
available while connection checks continued.

Real evidence now also includes three independent ACP sessions with Worker-to-Worker
request/reply without Boss privileges at execution time, plus a successful reverse
assignment: Antigravity as Boss discovers/delegates to Codex, receives the durable
completion message, reads the artifact and summarizes. The latter used three prompts
and four narrowly checked approvals through the normal operator API; input/send and
the resulting conversation were verified in Hermes. Service restart retained both
tasks and artifact hashes. This supersedes the older table's lack of real direct
messaging evidence; the table otherwise records the earlier release baseline.

Final checks: 448/448 tests, server/Web/Hermes type checks, Hermes build and formatting
passed. See `integrations/hermes-workbench/README.md` and the read-only verifiers for
the exact tasks, prompt ledger, immutable messaging checkpoint and current Git result.
The scope is a local Web workbench using installed ACP adapters; native Hermes desktop
packaging, attachments and per-token text streaming remain outside this increment.

## Conclusion

The implementation now proves the priority in AGENTS.md: user goal → selected Boss →
discovery → delegation → independent Worker ACP session → durable artifact → Boss
continuation → final response. This is a working control plane, beyond a UI prototype.
The agreed V0 delivery scope and local acceptance gates are complete, including the
authorized offline installation check. This does not establish universal external-adapter
compatibility or completion of enhancements outside V0. See the delivery checklist below.

## Requirements and evidence

| Original requirement | Current result | Evidence / limit |
| --- | --- | --- |
| Agent and role are separate; any eligible Agent may be Boss | Implemented through generic definitions, eligibility and project selection | Agent control and Fleet gateway tests; no vendor names as domain roles |
| Real two-Agent delegation and final response | Passed with Codex as selected Boss and Antigravity as Worker | `.run/collaboration-integration-20261022/real-pair/finalization.json`: both tasks completed, result 323, restart preservation true |
| ACP transport and scoped bridge | Implemented for supported stdio ACP adapters | Independent synthetic ACP process mainline and the real pair; arbitrary adapters still depend on their supported protocol capabilities |
| Direct Worker-to-Worker communication without Boss privilege | Implemented and covered by deterministic router/gateway and synthetic ACP process checks | `apps/server/src/v0-runtime-process.test.ts`, `fleet-gateway.test.ts`, `runtime-delivery.test.ts`; no claim of a real Codex/Antigravity Worker-to-Worker run |
| Durable tasks, messages, attempts, context and results | Implemented with SQLite/filesystem interfaces and migration coverage | Task engine, storage, message router, execution-context checks; real pair shutdown/reopen evidence |
| Large outputs as artifacts | Implemented with stored artifact references and UI preview | Artifact store and mainline result evidence |
| Human input, approvals, cancel and resume | Implemented with durable input and server-side action eligibility | Existing runtime input and ACP approval checks; resume creates a new attempt and is not a file rollback |
| Policy authority and honest execution boundaries | Implemented for mediated operations, with enforcement modes | Policy and permission tests; opaque Agent tools remain outside guaranteed interception; LocalRunner/worktrees are not OS sandboxes |
| Local directory / Git worktree lifecycle | Implemented, including reviewed merge, explicitly approved push and confirmed cleanup | Git workflow and cleanup checks; push evidence uses a local bare remote, not a user remote |
| Workbench UI | Project/task navigation, execution record, settings, approvals, artifact preview and message delivery filters are connected; R6 adds project SSE event notifications | R6 packaged cross-tab update check; disconnected streams use two-second refresh, healthy streams also reconcile global state every 15 seconds |
| AgentDefinition CRUD | Implemented with safe removal of unused disabled registrations | Used Agent definitions remain available for historical records |
| Task CRUD / state machine | R5 adds persistent drafts, title/objective editing, explicit start and confirmed deletion of unreferenced drafts, alongside queries/state transitions/cancel/resume | Executed tasks retain objectives and history; title changes and task instructions remain available. See `docs/architecture/task-record-management.md` for lifecycle constraints |
| Repository baseline | R6 standard pnpm 10 lint/typecheck/test/build passed, 425/425 cases with no skips; fresh offline frozen-lockfile installation passed separately | No fresh hosted CI or entire Playwright suite is claimed; targeted browser flows were checked |

The UI V2 document is a historical prototype specification. Later human-input, memory,
workspace and message-delivery features supersede its earlier backend limitations; the
prototype itself is not acceptance evidence for those features.

## Real Agent allowance

The original three ACP prompts and the explicitly approved one additional Codex summary
prompt have all been consumed. The additional turn read the completed Worker result and
saved the final summary, without creating another child or calling the Worker again.
These limits count host ACP prompts, not opaque internal provider calls. No real prompts
were used for this baseline review.

## Baseline validation and repairs

One full installed Vitest run executed 422 cases: 363 passed and 59 failed. The failures
were confined to five test files. Repairs aligned existing fixtures with the current
contracts: objective plus execution context, assignment-specific working directories,
tool names on direct service calls, complete message-panel snapshot data and wording,
and 14 migrations. Async fixture polling now waits for its condition instead of a fixed
number of event-loop turns. Directory-binding fixtures ran outside the protected install
tree; putting their temporary source directories inside that tree correctly caused refusal.
Production approval policy and directory protection were not weakened.

The affected five files were rerun: 97 of 99 cases passed; the remaining two stale migration
counts were then corrected and those two cases passed. Thus every original case has a
passing result in the baseline plus targeted repair runs. This is **not** a claim that a
second full suite ran after the repairs. Final full-format checking passed. Production
source was not semantically changed by these test repairs, so the existing R4 package was
not replaced merely to update tests and documentation.

Evidence under `.run/collaboration-integration-20261022/`:

- `v0-direct-baseline/progress.json` and `tests.json`: all package/server builds, web
  typecheck/build, and the initial full suite.
- `v0-focused-repair/tests.json`: the 99 affected cases.
- `v0-focused-final/tests.json`: the two final focused passes; skipped cases were not rerun.
- `v0-focused-final/lint.log`: final formatting result.
- `v0-validation-rollup.json`: per-case latest executed outcomes across the three reports.

The initial bundled pnpm 11.25.0 launcher could not run the project's pnpm 10.11.0 scripts in this
environment. Its attempted dependency-install step was stopped before replacement, and
the no-install retry failed in the Windows script launcher. Checks therefore used the
existing installed tool entrypoints with Node 22.22.2. No successful `pnpm install` or
fresh PR CI run is claimed by that initial report. The later pnpm 10 baseline below supersedes
the launcher limitation; historical logs remain intact.

## Remaining scope

The task CRUD gap identified in the initial review is addressed by the R5 operator draft
lifecycle, without deleting executed task history. The normal pnpm 10 script baseline is now
verified; fresh locked dependency installation subsequently passed in the explicitly
authorized isolated directory. No fresh hosted CI
execution is claimed. Real Worker-to-Worker and external-adapter permission checks remain
additional compatibility evidence, subject to a separately authorized prompt allowance.
Fine-grained policy editing, distributed infrastructure and OS isolation are not added
to V0 merely because more testing or features are possible.

## R5 follow-up

The draft workflow adds two passing deterministic tests beyond the 422-case baseline.
Core/storage/server builds and web typecheck/build passed. A clean R5 standalone package
passed its native SQLite/14-migration probe. Browser checks against that package verified
draft saving without an Agent, title/objective editing, list updates and deletion preview
cancellation. Actual deletion and execution were covered by isolated HTTP tests; no real
Agent prompt and no UI deletion was used. A package-backed database was reopened to verify
draft persistence. Evidence: `.run/collaboration-integration-20261022/task-records/workflow.json`
and `.run/task-records-ui-r1/preview.json`.

## Standard pnpm baseline and R6 event streaming

An existing local pnpm 10.11.0 installation was found and reused with Node 22.22.2; no
software was downloaded or installed. The actual repository `pnpm lint`, `pnpm typecheck`,
`pnpm test` and `pnpm build` commands passed on R5, with 424/424 test cases and no skips.
Evidence: `.run/collaboration-integration-20261022/r5-pnpm-baseline/progress.json` and `tests.json`.
The installed lock snapshot differs from the repository lock only by the later local
`@control-plane/workspace` link in the server importer; it was not rewritten to conceal this.

The subsequent design review found that `api-surface.md` explicitly specified SSE/WebSocket
events. R6 implements SSE project audit notices with durable cursor replay, a read-only
subscription and bounded connection lifetime. Its new focused test verifies project scope,
gap replay after database reopen, omission of large event payloads, no execution, and shutdown
with an active stream. Two browser tabs using the R6 package showed task updates from one
tab in the other while the UI reported its live connection. Evidence:
`.run/collaboration-integration-20261022/project-event-stream/workflow.json` and
`.run/project-event-stream-ui/preview.json`. No real Agent prompt was used.

After adding SSE, the same four standard pnpm 10 commands were run on the final R6 source
and all passed. The complete Vitest result is 425/425 passed, 0 failed, 0 skipped. Evidence:
`.run/collaboration-integration-20261022/r6-pnpm-baseline/progress.json` and `tests.json`.
The R6 package's first-party compiled files were compared by hash with this build.

## R6.1 delivery closeout

R6.1 corrects stale operator instructions (old migration counts and pre-real-pair status)
without changing the program. Its program/runtime hashes match R6. Actual `start.cmd`
launch, bundled synthetic Boss/Worker collaboration, final result, active-SSE shutdown and
restart persistence passed; the test-owned process exited. See
`.run/collaboration-integration-20261022/delivery-r6-1/packaged-mainline-r3/mainline.json`
and [the requirement-by-requirement delivery checklist](v0-delivery-checklist.md).
The remaining fresh installation gate subsequently passed after explicit operator approval.

## Authorized offline installation closeout

On 2026-10-22, pnpm 10.11.0 with Node 22.22.2 completed `install --offline
--frozen-lockfile` in `.run/collaboration-integration-20261022/offline-install-check`.
All 13 workspace projects were included: 250 cached packages reused and zero downloaded.
The staging lockfile and recorded source manifest/installed dependency metadata hashes
were unchanged. No global configuration was modified and no Agent was called.
Evidence: `PLAN.json`, `RESULT.json` and `install.log` in that isolated directory.
The R6.1 package and the existing 425-test baseline remain unchanged; no redundant suite
was run for this installation-only acceptance step.
