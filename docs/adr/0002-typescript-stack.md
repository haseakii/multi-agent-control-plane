# ADR-0002: TypeScript Monorepo for V0

Status: Proposed

## Context
ACP has a first-class TypeScript SDK and V0 is dominated by protocol I/O, local process management, APIs, WebSocket events, and web UI work.

## Decision
Use Node.js 22+, TypeScript strict mode, and pnpm workspaces.

Primary stack:
- Fastify
- React + Vite
- SQLite + Drizzle
- Zod
- Pino
- WebSocket
- Vitest
- Playwright

## Consequences
The protocol/runtime and web/API layers share schemas and types. Performance-sensitive runner components may later move to Rust/Go behind a stable transport without changing the domain model.
