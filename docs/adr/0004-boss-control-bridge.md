# ADR-0004: Boss Uses a Control Bridge

Status: Proposed

## Context
ACP controls an agent but does not guarantee that an ACP agent can call control-plane orchestration operations.

## Decision
Expose one semantic orchestration API through pluggable bridges:
1. MCP (preferred)
2. `agentctl` CLI fallback
3. validated structured-command fallback

An agent is Boss-capable only when at least one supported bridge is available and policy allows orchestration.

## Consequences
Any eligible ACP agent can become Boss without hard-coding provider behavior. MCP-capable agents get the richest integration; less capable agents can still orchestrate through fallback bridges.
