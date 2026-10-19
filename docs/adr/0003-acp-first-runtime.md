# ADR-0003: ACP-First Agent Runtime

Status: Proposed

## Context
Coding agents expose different commands, models, auth flows, and tools. The control plane needs a common lifecycle contract.

## Decision
Use ACP as the required V0 host-to-agent protocol. Vendor-specific CLIs are configured as ACP runtime definitions/adapters, not modeled in the core domain.

Support protocol-version differences behind capability-gated adapters.

## Consequences
The core can register arbitrary compatible agents. Agents that are not ACP-compatible require an external adapter rather than special-case code in the orchestrator.
