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
- **Policy is outside agents.** Agents can request actions; the control plane makes the final allow/ask/deny decision.
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

## V0 success criteria

V0 is successful when a user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and have the Boss discover and delegate tasks to another ACP worker through the control plane with durable tasks/messages and visible execution history.

See [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/architecture/v0-scope.md](docs/architecture/v0-scope.md).
