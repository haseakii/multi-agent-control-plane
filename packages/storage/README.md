# storage

Local-first durable persistence for the control plane.

## V0 implementation

- SQLite metadata/state store
- WAL mode, foreign keys, bounded busy timeout
- Drizzle schema and migration runner
- repositories for the provider-neutral core entities
- append-only audit/event repository
- restart-safe file-backed tests
- best-effort secret rejection on task/message/event persistence boundaries

Artifact blob bytes remain the responsibility of the separate `artifacts` package; this package stores artifact metadata only.

The current secret guard rejects structured secret-bearing keys and high-confidence credential patterns. It is a defense-in-depth boundary, not a general DLP engine. Callers must never intentionally place credentials in task/message/event content.

External-client attachment references require an existing binding in the authorized
project or that client's durable upload receipt for the same project and bytes.
Unbound owner uploads do not grant client access. This check reuses existing task
bindings and upload audit records, including legacy records; it adds no durable fields.
