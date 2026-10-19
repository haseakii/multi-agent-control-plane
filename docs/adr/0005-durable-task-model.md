# ADR-0005: Tasks Are Durable and Separate from Conversations

Status: Proposed

## Context
Provider conversations can fail, expire, be replaced, or accumulate poor context. Project work must survive those failures.

## Decision
Task is the durable unit of work. Conversation/ACP session is an execution resource linked through an execution attempt.

Retries, agent changes, and session replacements create new execution records without rewriting prior history.

## Consequences
Task graphs can survive process restarts and vendor changes. The UI can show both business/task progress and lower-level conversation execution history.
