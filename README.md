# Multi-Agent Control Plane

A **local-first, vendor-neutral control plane for ACP-compatible AI agents**.

The project does not hard-code Codex, Gemini, Claude, OpenHands, Antigravity, or any other agent into fixed roles. Agents are registered as generic runtimes with capabilities and permissions; roles are task-scoped; any eligible agent can be selected as the **Boss / Orchestrator**.

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

### Principles

- **ACP-first, vendor-neutral.** ACP is the primary host-to-agent transport; specific vendors are adapters/configuration, not domain concepts.
- **Agent != role.** Roles are dynamic assignments created by the Boss or user for a specific task.
- **Boss is an agent with orchestration privileges.** The framework does not ship a permanently hard-coded supervisor model.
- **Agent-managed auth by default.** Existing agent login/auth flows remain owned by each ACP agent.
- **All agent-to-agent communication is observable.** Logical A→B communication is physically routed through the control plane.
- **Tasks outlive conversations.** Durable task state is the system of record; ACP sessions are execution resources.
- **Artifacts are references, not chat payloads.** Large diffs, files, logs, images, reports, and test outputs live in a content-addressed artifact store.
- **Local-first.** SQLite + local filesystem are the default; distributed backends are replaceable adapters.
- **Policy is outside agents, with an explicit boundary.** The control plane enforces calls that pass through its APIs, bridge, workspace/Git services, and ACP permission requests actually surfaced by an adapter. It cannot automatically intercept opaque tools or side effects executed inside an agent process.
- **LocalRunner is a trusted-user convenience mode, not a security sandbox.** Git worktrees reduce write conflicts but do not restrict OS-level access. Use an isolated runner for untrusted agents or strict filesystem/network guarantees.
- **OpenHands is optional integration, not a dependency.**

## Proposed stack

- Node.js 22+
- TypeScript
- pnpm workspace
- Fastify
- React + Vite
- SQLite + Drizzle ORM
- Zod
- Pino
- WebSocket
- ACP TypeScript SDK
- Vitest + Playwright

## Repository status

This PR establishes the architecture and package boundaries; it is **not yet a runnable application**. Workspace package manifests, executable build/test/lint/typecheck scripts, CI, and the health endpoint are tracked by Issue #1 and will be added with the bootstrap implementation.

## V0 success criteria

V0 is successful when a user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and have the Boss discover and delegate tasks to another ACP worker through the control plane with durable tasks/messages and visible execution history.

See [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/architecture/v0-scope.md](docs/architecture/v0-scope.md).
