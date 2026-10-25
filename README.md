# Multi-Agent Control Plane

A **local-first, vendor-neutral control plane for ACP-compatible AI agents**.

The project does not hard-code Codex, Gemini, Claude, OpenHands, Antigravity, or any other agent into fixed roles. Agents are registered as generic runtimes with capabilities and permissions; roles are task-scoped; any eligible agent can be selected as the **Boss / Orchestrator**.

## Start the Hermes workbench on this machine

The fixed installation now owns release selection. Double-click `升级工作台.cmd` and choose a complete new package to upgrade with backup and recovery; `恢复工作台.cmd` handles interrupted maintenance. Startup and MCP configuration stay fixed across upgrades. See [simple delivery](docs/guides/simple-delivery.md) for daily use and the single build-side publish command.

Double-click `启动工作台.cmd` to start or reuse the background service and open `http://127.0.0.1:8057/`. You can close the launcher window. Codex's configured `local_collaboration` entry also starts the same engine when needed. Use `停止工作台.cmd` for a normal shutdown; a later MCP call can start it again. `start-hermes.cmd start` / `stop` and the integration directory's `start.cmd` / `start-real.cmd` are aliases for this same daily service. The historical PowerShell development scripts are separate, explicit development tools, not daily startup instructions.

Choose an execution mode, member and working directory, then enter your goal and send it. Direct execution works with an ordinary ready member; orchestration requires a member with the Boss role and MCP orchestration scope. The same conversation accepts instructions while running and follow-up requests after completion. Use the workbench's **使用说明** button for the complete flow and links to member setup, a new task and the current task process. The earlier three-prompt acceptance cap does not limit daily use.

Use “协作成员” to register or edit local agents and check their connections. Editing a display name, description or capability labels preserves the observed connection and login state. Changes to runtime, authentication or collaboration authority require a fresh check. See the [current delivery guide](docs/guides/hermes-local-delivery.md) for startup, data, backup, recovery and verification scope.

For multiple ACP products, search registered members by name or capability and filter those ready for tasks, needing connection/login attention, or disabled. “查看已有成员” in the product catalog and the member link after registration take you directly to that member's card; unfinished onboarding entries remain available to continue later.

You can reopen a task using its workbench URL (`/?task=...`), including links from Codex or bookmarks. Opening the link only restores the conversation; it does not send or retry a task. Use the conversation's round markers to jump directly to earlier requests while reviewing a long exchange.

## Use the same engine from Codex or another MCP client

The `local_collaboration` stdio MCP service exposes project/agent discovery, task submission,
incremental progress, artifacts, follow-up, cancellation and preparation of a fixed code review.
It is registered in this machine's Codex configuration and can start the local engine in the
background; opening the web interface is optional. Both entries use the same durable data.
An external client coordinates its selected ACP agents directly. The web Boss/Worker flow
remains available, with no hard-coded vendor roles.

Follow-up rounds inherit unmerged code in a new isolated workspace. Human permission decisions,
review approval, merge and push remain in the web workbench. The MCP connection does not copy
provider credentials or automatically inherit an external client's complete chat or model cache.
See [external client setup and limits](docs/guides/hermes-local-delivery.md#网页与外部-agent-入口).

## Core idea

```text
User / API / UI
      |
      v
+---------------------------+
|   Agent Control Plane     |
|---------------------------|
| Agent Registry            |
| Task Engine               |
| Boss Runtime              |
| Message Router            |
| Context / Memory          |
| Artifact Store            |
| Policy / Approval         |
| Runner / Workspace        |
+-------------+-------------+
              |
              v
          ACP Runtime
      /       |        \
  Agent A   Agent B   Agent C
```

## Principles

- **ACP-first, vendor-neutral.** Specific vendors are adapters/configuration, not domain concepts.
- **Agent != role.** Roles are dynamic and task-scoped.
- **Boss is an agent with bounded orchestration privileges.** No fixed supervisor model is required.
- **Agent-managed auth by default.** Authentication remains owned by each ACP agent.
- **All agent-to-agent communication is observable.** Logical A→B communication is routed through the control plane.
- **Tasks outlive conversations.** Durable task state is independent from ACP session state.
- **Artifacts are references, not chat payloads.** Large outputs live in a content-addressed artifact store.
- **Policy has an explicit boundary.** Opaque agent-owned tools are not assumed to be intercepted.
- **LocalRunner is not a security sandbox.** Git worktrees do not restrict OS-level access.
- **OpenHands is optional integration, not a core dependency.**

## Current implementation progress

R5 adds operator task drafts: save a goal before connecting an Agent, edit its title and
objective, then explicitly start the same durable task. Unexecuted, unreferenced drafts
can be deleted after confirmation. Executed tasks retain their objective/history and
allow display-title changes; further requirements use task instructions. See the
[task-record lifecycle and API](docs/architecture/task-record-management.md).

R6 adds project SSE notifications: task changes refresh the workbench as audit events
arrive, and reconnects can replay missed event notices. The console falls back to timed
refresh if the stream is unavailable. Subscriptions never start or retry Agent work.

The main workspace now includes mediated task-to-task messaging with correlated result
delivery, explicit routing and retry receipts; durable operator instructions delivered at
the next ACP prompt boundary; atomic assignment/attempt creation; and live execution
authority checks before mediated mutations. ContextBuilder supplies and records selected
task/dependency/artifact context before each execution. The console puts child-task progress,
result access and operator input ahead of the collapsed execution history. Assignments now
use durable task-local directories or Git worktrees, reuse them on recovery, and publish
tracked and non-ignored new Git files for review. Shared-directory execution is an explicit project choice.
The console can prepare immutable change reviews, approve a specific snapshot and separately
merge it into the unchanged clean local target branch. Existing compatible target changes
are retained. Reviewed commits can be pushed through a separate explicit approval and
confirmation flow. Operator cleanup previews the managed directory, safe branch deletion
and merged review refs; it preserves durable history and refuses content that has not been
preserved. Unmerged refs and independent branch history remain available.
Project memory now supports manual proposals, acceptance/rejection, corrections and archive,
with task/artifact provenance. Accepted records are saved in each execution context snapshot;
SQLite FTS5 searches accepted memory and published text artifacts from the console.
Boss and Worker can also search project knowledge and propose memory through explicitly
scoped MCP tools. Proposals retain the actual Agent/task provenance and require human
acceptance. The console can edit each Agent's collaboration scopes independently of Boss eligibility.
Existing Agents can also become Boss candidates through the settings UI. A first-collaboration
guide links registration, role selection, explicit ACP connection checks, workspace setup and
goal entry. Initial Boss discovery works without capability filters, then can narrow candidates.
Project policy is versioned and editable from the console: mediated Fleet tools can be
allowed or denied per project, local Git merges require approval or can be denied, and
requiring OS isolation refuses new execution on the current LocalRunner.

The message panel now shows persisted delivery receipts, pending/attention filters and direct
recipient-task navigation. Reading the view never starts or retries an Agent, and a completed
turn is not presented as proof that the Agent understood the message.

Deterministic ACP subprocess collaboration and the bounded real Codex + Antigravity
Boss-to-Worker-to-Boss mainline have recorded evidence. The agreed V0 delivery and local
acceptance gates are complete: standard pnpm checks passed with 425 tests, and an authorized
fresh offline frozen-lockfile installation reused 250 packages with zero downloads.
Broader real Worker-to-Worker and external-adapter permission compatibility remain outside
that evidence. See the [V0 delivery checklist](docs/roadmap/v0-delivery-checklist.md).
Richer resource/Agent-specific policy is an enhancement, not an additional V0 gate.
Search indexes text prefixes and reports
unindexed legacy artifacts; it does not promise exhaustive large-file search. Source integration does not update any
already-running release service.

## Stack

- Node.js 22+ and pnpm 10
- TypeScript strict mode
- Fastify API
- React + Vite
- SQLite + Drizzle ORM
- Zod runtime schemas
- Vitest + Playwright
- GitHub Actions

## Quick start

Prerequisites: Node.js 22+ and pnpm 10.

The default install targets Windows, macOS, and Linux (glibc or musl) on x64 or
arm64, using the native SQLite binaries bundled with the pinned `better-sqlite3`
package. Its unnecessary install-time rebuild is disabled so Windows does not
require Visual Studio C++ build tools. Other operating systems or architectures
need a separately configured source build and are not covered by this setup.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Browser tests start their own API and web servers; stop any existing services on
ports 3000 and 4173 before running them. Tests never reuse your normal local API
or its database.

Start the API and web UI in separate terminals:

```bash
pnpm dev:server
pnpm dev:web
```

The API health endpoint is available at [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health). The web control-center bootstrap runs at [http://127.0.0.1:5173](http://127.0.0.1:5173).

See [local development and IDEA debugging](docs/guides/local-development.md) for
the shared API/Web run configurations, isolated data paths, and source debugging.

## Repository status

The local V0 implementation includes durable SQLite tasks, assignments, execution attempts, messages, artifacts and approvals; ACP runtime registration; explicit Boss selection; task submission/cancellation/recovery; and a task-first web workspace. Deterministic fixture and local API/browser regressions cover these paths. Opaque Agent tools are not guaranteed intercepted, and LocalRunner is not an OS sandbox.

Real two-Agent Boss delegation completed with Codex and Antigravity; the durable result and restart evidence are recorded in the V0 delivery checklist. External ACP executables require their own installation and authorization; `.cmd`, `.bat` and `.ps1` wrappers are rejected. New projects can create an empty managed workspace or explicitly validate and bind an existing Windows local directory; see B0 below.

## Windows directory release (A0-R1, including stopped backup/restore)

Builders run `pnpm release:windows --output NEW_DIRECTORY` on the verified Windows x64 machine with existing locked dependencies. The builder includes the local official Node runtime and its LICENSE, production dependencies (no pnpm links), workspace dist, web dist and SQLite migration journal. The package also includes the repository Apache LICENSE and full notices for the actual bundled frontend dependencies. The builder requires Node v22.22.2 with a valid OpenJS Foundation signature and never downloads a replacement. It refuses to overwrite a directory and checks native SQLite loading before reporting success.

Recipients run **`start.cmd`** in a foreground terminal. They need no IDE, pnpm or compiler. A single Fastify loopback port serves the UI and API with the same Host/Origin checks. `config.json` controls port/dataDir/logLevel; dataDir is anchored to that file, with SQLite/artifacts/workspaces/logs kept together and separate from developer environment settings. The package starts empty and never seeds or calls Agents automatically. It excludes first-party test data and user credentials; third-party packages may retain their upstream tests/examples.

Stop with Ctrl+C in that terminal and wait for exit. The release uses a fail-closed exclusive data-directory lock; after a crash, verify the recorded process has exited before manually removing only a stale lock as explained in `RUN.txt`. Stopped consistent backup/restore are now available through `start.cmd backup --config CONFIG --output NEW_BACKUP` and `start.cmd restore --backup BACKUP --output NEW_OR_EMPTY_DIRECTORY`; see `RUN.txt` for exact steps. Backups preserve private user database content, validated configuration, versions, checksums and only referenced artifacts. They exclude logs, workspace source and external ACP installs/logins; database metadata may retain external paths. Keep backups local and private. Restore validates everything before activating a new directory, never overwrites original data, and does not replay tasks or call Agents. Marked partial directories cannot start. No external stop command is implemented; do not treat a running WAL database copy as a backup. No service, autostart, firewall changes, public binding, Docker or desktop shell are required.

## V0 success criteria

V0 is successful when a user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and have the Boss discover and delegate tasks to another ACP worker through the control plane with durable tasks/messages and visible execution history.

See [docs/architecture/overview.md](docs/architecture/overview.md), [docs/architecture/v0-scope.md](docs/architecture/v0-scope.md), and [docs/roadmap/v0.md](docs/roadmap/v0.md).

See [real-agent preflight](docs/guides/real-agent-preflight.md) for the disabled
Codex ACP example and offline-only `pnpm diagnose:agent` command.

## ACP access center A0

Open Agent & project settings for the official catalog and existing local entries. Catalog reads are offline by default. Only the explicit refresh button fetches the fixed generic ACP registry URL; it rejects redirects, times out after 8 seconds and limits metadata to 1 MiB. The cached contract follows the official agent schema (binary/npx/uvx), with local resource limits. Text and distribution commands are untrusted display data; no icons, packages, environment values or commands are downloaded/executed from catalog entries.

Binding an existing entry requires explicit local executable/Node entry paths and arguments. It saves an ordinary AgentDefinition, defaults to disabled, and never installs or starts an Agent. Catalog versions do not prove installed versions or publisher identity. This first increment does not persist software provenance or manage updates; custom entries remain supported. Enable and probe are separate explicit actions. Probe starts the selected third-party process and sends initialize only; it does not create sessions, authenticate or send model prompts. Negotiation displays protocol/agent information, capabilities, auth methods and observation time; opaque extensions are withheld and sensitive/oversized metadata is redacted or bounded. Unknown login stays unknown. Existing explicit nonterminal ACP authentication remains separate; terminal auth requires a real interactive terminal and is never sent as authenticate.

Role intention, ACP connectivity, authentication, model execution and Fleet permission scopes are separate. Boss is a product role, not a provider or ACP capability. The page displays configured scopes, not live credentials, and does not grant external MCP/filesystem/terminal access. Agent-owned tools are not an OS sandbox boundary. Install/update and catalog login are visibly unavailable in A0. Google self-built-client licensing remains unconfirmed; do not use consumer headless/OAuth workarounds.

A0 requires no SQL schema migration or existing AgentDefinition rewrite. B0 adds the sixth migration described below. Negotiation remains process-local and becomes unknown on server restart or definition changes. Catalog cache lives under data/cache and is deliberately excluded from private backups; restored registrations still work independently of the catalog. Keep M2-R1 and its pre-A0 data backup as the rollback baseline. Set CONTROL_PLANE_E2E_DATA_DIR for isolated browser test DB/artifact/workspace paths; browser screenshots from deterministic cache fixtures are labeled separately from live official-catalog captures.

## A0-R1 delivery boundaries

The Windows directory package includes the ACP access center and the reviewed A0-R1 fixes: stale probe/auth responses cannot overwrite changed configurations; authentication metadata and public observations are bounded without shortening executable authentication IDs; explicit local cwd must exist as a directory. Existing-entry binding remains disabled by default.

Installation, upgrades, uninstall and persistent login management are not implemented. Existing nonterminal ACP authentication is an explicit action; terminal login remains outside this API. Probe means initialize/connectivity only, and becomes unknown again after a definition change or server restart. Catalog cache is optional and excluded from private backups. External Agent installations and their credentials are not bundled.

Separate acceptance evidence now covers the deterministic Boss -> Worker -> Boss API/CLI chain and a real Codex + Antigravity mainline. Codex discovered/delegated to Antigravity, read its durable `17 × 19 = 323` result, and resumed to save the final summary. Both tasks, their message and artifacts survived restart. This used the user's original 3 ACP prompts plus an explicitly authorized 1-prompt recovery; no Worker was rerun during recovery. See [the dated real-agent record](docs/guides/real-agent-preflight.md) and `.run/collaboration-integration-20261022/real-pair/finalization.json`. The user also confirmed the historical 8031 console displayed after manual Edge address-bar navigation; this does not validate every browser action. Physical Windows Ctrl+C remains unverified; automated shutdown evidence uses application close or a test-owned IPC signal wrapper.

## B0: bind an existing Windows directory

In the new-project form, choose **Workspace source → existing directory**, enter an absolute path, validate it, and confirm the displayed actual path before creating the project. The API is POST /api/directories/validate, followed by POST /api/projects with workspace.kind=existing-local, validationId and confirmedPath. Managed empty workspaces remain the default. Validation expires after five minutes; a changed path or directory identity requires validation again. Binding only reads metadata for the explicitly selected path and its parents. It never lists source contents, runs Git, clones, copies, creates a missing directory, performs a write probe, cleans up source, or starts an Agent. A read-only directory can be bound; an eventual task may still fail if its requested work needs writing.

B0 accepts existing readable directories on Windows fixed local disks. Relative/drive-relative paths, UNC/device paths, drive/home roots, credential directories, reparse points (including junctions), and overlap with runtime/install data or another bound project are rejected. Built-in Windows PowerShell reads volume/reparse metadata using a constant script and data-only input; no software installation or execution-policy change is required. The displayed canonical path resolves short-name and case aliases; redirection through links is rejected rather than silently followed. This checks metadata at validation and before execution, not an OS isolation guarantee against a concurrent privileged filesystem change.

Submitting a goal in a bound project opens an execution-impact confirmation with the exact workspace path. The request binds workspace ID, path and a runtime-specific version; cancellation sends no goal. Recovery also requires rechecking that path. Restart/restore invalidates the old confirmation. A conflicting explicit Agent cwd is rejected before spawn; accepted existing-directory runs use the same canonical process cwd and ACP session cwd. Binding never grants MCP/filesystem/terminal scopes, creates persistent security authorization, or prevents opaque Agent-owned tools from accessing other paths. Only run tasks you intend to authorize.

The sixth SQLite migration adds workspace_directory_bindings without rewriting existing workspace JSON. Existing unbound workspaces keep their prior behavior. Migration is forward-only: preserve the A0-R1 package and a stopped pre-B0 data backup; never open a migrated B0 database with A0-R1. Private restore accepts only its exact application/migration format, so use the corresponding package for older backups.

Private backups include database binding metadata and referenced result artifacts, **not external workspace source**, logs, external Agent installs or credentials. Backup/restore do not visit the external path and can preserve an offline binding. After restore, verify the path and identity before explicit execution; an unavailable or replaced directory cannot run automatically. Keep database backups private: they still contain user task content and directory metadata. B0 does not provide rebinding, cloning, directory cleanup or a native folder picker. Current B0 source checks are separate from the frozen A0-R1 directory package; no new release package is implied by this section.
