# fleet-mcp

The preferred MCP control bridge for Boss agents.

The package exposes the control-plane orchestration surface as MCP tools while keeping business logic in injected application services.

V0 rules:
- the bridge identity is bound to a concrete AgentDefinition and session context;
- only enabled, Boss-capable agents configured for MCP with `boss.orchestration` may create the Boss bridge;
- tools are registered from bridge scopes; messaging and artifact scopes remain independent from Boss orchestration;
- every tool call runs through an authorization hook before shared application services;
- every allowed, denied, and failed call is audited;
- tool inputs never accept a caller-controlled sender identity;
- capabilities help discovery and routing but never grant execution permissions.

The server factory can be connected to the official MCP stdio transport with `serveFleetMcpStdio`. Wiring a concrete process-host/application-service client is a separate composition concern; the MCP adapter itself does not duplicate task, registry, policy, message, artifact, or approval business logic.


## ACP session attachment and stdio proxy

`FleetBossSessionAttachment` creates the ACP v1 stdio MCP server configuration for Boss sessions and recreates it on resume. It uses a short-lived bridge grant rather than provider credentials.

`InMemoryFleetBridgeGrantStore` stores only SHA-256 token hashes and supports issue, session binding, expiry, resolution, and revocation. A server composition can use it to authenticate loopback bridge requests.

`FleetBridgeHttpProxy` is the stdio-side adapter: the child MCP process uses the opaque grant as a Bearer credential when calling the parent control-plane gateway. Tool request bodies contain only tool name + validated input; agent/session identity is resolved from the grant by the parent process rather than accepted from the child.

`stdio-proxy-main.ts` is the process entry point. It expects `CONTROL_PLANE_BRIDGE_URL` and `CONTROL_PLANE_BRIDGE_GRANT`. The parent gateway remains responsible for real policy checks, audit, and shared application-service dispatch.
