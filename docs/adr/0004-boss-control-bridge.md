# ADR-0004: Scoped Control Bridge for Boss and Workers

Status: Proposed

## Context
ACP controls an agent but does not guarantee that an ACP agent can call control-plane orchestration operations. Agents also have different support for session-level MCP configuration and may need different levels of bridge access.

## Decision
Expose one semantic control-plane API through pluggable bridge transports:
1. MCP (preferred when the ACP agent supports session-level MCP configuration)
2. `agentctl` CLI fallback when supported
3. validated structured-command fallback when supported
4. none, for agents that only execute assigned work

Bridge transport is separate from bridge scope. Scopes include:
- `boss.orchestration`
- `agent.messaging`
- `artifact.read`
- `artifact.publish`
- `task.status`

A Boss must be explicitly eligible, have a usable transport and the `boss.orchestration` scope, and pass policy checks. A worker may have only the messaging/artifact scopes it needs. A worker with no bridge can still execute an assigned task but cannot initiate control-plane bridge operations.

For supported ACP agents, the host attaches the Fleet MCP server through session-level `mcpServers` configuration during session creation and resume. V0 defaults to a local stdio MCP server. Each bridge request is authenticated as the calling agent/session, checked against project/task scope, policy-evaluated, and audited. Short-lived bridge authorization is separate from provider credentials.

All transports call the same application services; no bridge can bypass policy or grant itself new scopes.

## Consequences
Positive:
- any eligible agent can be Boss without vendor-specific orchestration code
- workers can receive narrowly scoped collaboration tools without Boss privileges
- session configuration avoids depending on manual edits to vendor-owned MCP config

Negative:
- adapters must declare and test which bridge transport/session capabilities they support
- bridge scope and policy checks are required on every call
- ACP permission mediation and LocalRunner do not guarantee interception of all agent-internal side effects; see the security architecture
