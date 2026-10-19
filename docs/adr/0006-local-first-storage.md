# ADR-0006: SQLite + Filesystem as V0 Durable Store

Status: Proposed

## Context
The primary initial use case is a local developer running a small-to-medium agent fleet. Requiring Redis, Kafka, PostgreSQL, S3, or Kubernetes would make installation unnecessarily heavy.

## Decision
Use SQLite in WAL mode for metadata, messaging, task state, approvals, and audit events. Store immutable artifact blobs in a local content-addressed filesystem.

All storage is accessed through interfaces so alternate implementations can be added later.

## Consequences
V0 is easy to install and back up. Very large distributed deployments will require different adapters, but not a new domain model.
