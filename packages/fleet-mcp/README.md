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
