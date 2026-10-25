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

## Test scope and cost

- Own exhaustive state/input matrices in the smallest deterministic unit that decides them. HTTP/MCP tests verify representative wiring and output parity instead of repeating the whole state matrix.
- Use actual process, Git, SQLite reopen and byte-level attachment tests where those boundaries matter. Keep distinct permission, migration, cancellation and recovery failure modes; a lower test count is not a goal by itself.
- Test responsive behavior at multiple widths when the layout or interaction differs. Shared business flows need one representative width; preserve narrow-screen focus, keyboard, overflow and long-text coverage.
- `pnpm test:e2e` is the deterministic local browser gate. `pnpm test:e2e:live` explicitly checks external official-catalog availability, using separate private data. Neither command authorizes real model execution.
- Add a regression that fails for the original defect. Prefer extending an existing focused case over adding another expensive fixture for the same assertion. Do not hide, skip or loosen a failing case to reduce maintenance.

## Security
Never commit model-provider credentials, login tokens, session cookies, or raw secrets. Test fixtures must use synthetic credentials.
