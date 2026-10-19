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

## Stack

- Node.js 22+ and pnpm 10
- TypeScript strict mode
- Fastify API
- React + Vite
- SQLite + Drizzle ORM (planned)
- Zod (planned)
- Vitest + Playwright
- GitHub Actions

## Quick start

Prerequisites: Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Start the API and web UI in separate terminals:

```bash
pnpm dev:server
pnpm dev:web
```

The API health endpoint is available at [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health). The web control-center bootstrap runs at [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Repository status

The repository now has a runnable Phase 0 baseline: server health endpoint, web shell, strict TypeScript project configs, unit and browser smoke-test harnesses, and CI quality gates. Agent registry, ACP runtime, persistence, orchestration, and the remaining control-plane features are subsequent issues.

## V0 success criteria

V0 is successful when a user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and have the Boss discover and delegate tasks to another ACP worker through the control plane with durable tasks/messages and visible execution history.

See [docs/architecture/overview.md](docs/architecture/overview.md), [docs/architecture/v0-scope.md](docs/architecture/v0-scope.md), and [docs/roadmap/v0.md](docs/roadmap/v0.md).
