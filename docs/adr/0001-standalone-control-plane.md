# ADR-0001: Standalone Control Plane

Status: Proposed

## Context
The initial investigation considered building directly on top of OpenHands or Microsoft Agent Framework. The intended product, however, needs to treat those systems as optional participants rather than architectural owners.

## Decision
Build a standalone control plane with its own durable domain model and public APIs.

OpenHands may be integrated through adapters/UI bridges. Microsoft Agent Framework, LangGraph, CrewAI, or other orchestration frameworks may be connected later but are not core dependencies.

## Consequences
Positive:
- vendor/framework neutrality
- stable task/message semantics across agent implementations
- easier local deployment and alternate UIs

Negative:
- we own orchestration state, persistence, and policy implementation
- more initial engineering than a framework-specific plugin
