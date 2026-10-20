# Real-agent preflight

The checked-in example is disabled and is never auto-imported into the registry.
It grants no Boss role or control bridge. Fixture acceptance does not establish
that a real provider has been connected.

## Offline diagnosis

```sh
pnpm diagnose:agent
pnpm diagnose:agent --config examples/agents/codex-acp.windows.disabled.json
```

The command first builds the local core package so schema imports work from a
clean checkout without pre-existing `packages/core/dist`. It does not build or
launch an adapter. The default example contains placeholder paths, so exit code 1
is expected.
Exit 0 means only that the schema and selected path metadata checks passed;
the agent may still be disabled. Exit 2 means invalid CLI arguments.
The tool reads only the selected JSON and stats configured executable/entrypoint
paths. It does not search PATH, read auth files or environment values, run help
or version commands, register an agent, authenticate, or open a connection.
It deliberately does not echo configuration values or raw parsing errors.

On Windows, Runner uses `shell:false` and rejects `.cmd`, `.bat`, and `.ps1`
commands before spawning. Use an absolute `node.exe` plus the locally installed
adapter's JavaScript entrypoint in `args`, or a genuine native executable.
Do not put a shell command string into `runtime.command`.

## Version provenance and initialization record

On 2026-10-20, public npm metadata was queried for Codex ACP 2.2.2 and
Codex 0.163.0. The latter was a catalog candidate, not the tested backend.
The subsequent project-local installation of `@agentclientprotocol/codex-acp@2.2.2`
actually resolved `@openai/codex@0.160.1`, within its declared `^0.160.1` range.
The separate installation lockfile records that resolved dependency tree.
These are dated fixed versions, not a claim of the latest release.
See the [maintainer documentation](https://github.com/agentclientprotocol/codex-acp).
No adapter dependency or installation files are added to the repository source.

Windows initialize-only validation used that installed pair, an isolated empty
agent configuration and a synthetic workspace. Absolute Node plus the actual
JavaScript entrypoint with `shell:false` returned ACP protocol version 1.
Only `initialize` was sent: no session creation, authentication, model prompt,
or provider-backed Boss/MCP acceptance was performed. Reported capabilities are
advertisements, not acceptance evidence. The processes were cleaned up.
The disabled example remains unregistered and is not the live probe config.

## Connection requires a separate decision

Do not enable or probe the example before adapter installation and initialization
are authorized. Initialization can start processes, load user configuration, and
access a network even without a model prompt. A local login-status result does
not prove online access, quota, or permission to consume that account.

For a later synthetic acceptance test, choose the provider/model, authorized auth
method, data scope and budget first. Use a separate workspace/database and review
the agent's configuration, skills and MCP sources. An empty cwd is not isolation;
LocalRunner is not an OS sandbox. Do not copy provider credentials into config,
task payloads or artifacts. Do not assume this disabled sample enforces read-only
mode or implements credential injection.
