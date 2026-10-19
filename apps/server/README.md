# server

Fastify control-plane API host and scoped Fleet MCP bridge.

V0 responsibilities:
- agent registry and capability discovery
- project/Boss configuration
- durable task engine
- message routing
- approvals
- artifact service integration
- realtime event API
- per-session Fleet MCP tool exposure through stdio

The MCP bridge is constructed for an authenticated agent/session. Session scopes must be a subset of the agent definition's configured bridge scopes. Every tool call is policy-checked and audited before and after invoking the shared application service. MCP scope and capability matching are not substitutes for execution-boundary authorization.

The bridge intentionally accepts application services as dependencies rather than reimplementing task, message, artifact, or approval logic. A production bootstrap must bind these dependencies to the same services used by HTTP routes and must derive the principal from the authenticated ACP session, never from tool arguments.
