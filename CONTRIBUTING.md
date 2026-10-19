# Contributing

This project is architecture-first during V0.

## Before coding
Read:
- `README.md`
- `AGENTS.md`
- `docs/architecture/overview.md`
- relevant ADRs in `docs/adr/`

## Change policy
- Architectural changes require an ADR or an update to an existing ADR.
- Keep vendor-specific behavior in adapters.
- Keep core domain types free of process/runtime assumptions.
- Prefer small pull requests mapped to one issue.
- Include tests for task-state transitions, message delivery, policy decisions, and ACP lifecycle behavior.

## Commit style
Use conventional prefixes where practical: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Security
Never commit model-provider credentials, login tokens, session cookies, or raw secrets. Test fixtures must use synthetic credentials.
