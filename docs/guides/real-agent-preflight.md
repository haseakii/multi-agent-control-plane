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

### Dated real pair result — 2026-10-22

The user selected Codex and Antigravity and authorized project-local installation of the
official Antigravity ACP 1.4.1 Windows x64 adapter. The archive came from Google's download
host through the [ACP registry entry](https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json).
Its SHA-256 was `5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554`;
the extracted `agy_acp_server.exe` had a valid Google LLC Authenticode signature. This is a
dated installation record, not a claim about the latest version. Neither adapter nor login
profile is included in the standalone control-plane package.

Both Agents returned ACP version 1 and created sessions. Initialization left authentication
unknown; supported native `chat-gpt` and `oauth-personal` authentication calls subsequently
confirmed readiness. The Agents loaded their own existing login state; the control plane
did not read or copy credentials into task context.

The first real prompt exposed unknown-auth discovery exclusion. After authentication,
Codex discovered and delegated to Antigravity, which returned a durable `17 × 19 = 323`
result with independent verification. Codex retrieved that artifact, but the subsequent
result-receipt continuation hit the initial three-prompt cap before forwarding. With explicit
approval for one additional Codex prompt, the same Boss task resumed and stored its final
summary. Both tasks remained completed after reopening SQLite, with messages/results retained.
Finalization denied task creation/delegation and allowed only the Codex runtime to launch.

Evidence: `.run/collaboration-integration-20261022/real-pair/finalization.json`, with the
original and supplemental prompt ledgers alongside it. Total use was 3 + 1 authorized host
ACP prompts; internal provider request counts are unknown. This proves the bounded real
two-Agent mainline and recovery, not all external adapter tools, permissions or messaging cases.

### Prepare a two-Agent acceptance run offline

```sh
pnpm prepare:collaboration --boss BOSS_JSON --worker WORKER_JSON --output NEW_REPORT_JSON
```

Use two explicitly selected AgentDefinition files. This command checks their schemas,
selected local path metadata, distinct registrations/entries, Agent-managed auth mode,
capability metadata and Boss bridge scopes. It never registers, enables, probes, authenticates
or prompts either Agent. It writes a new report exclusively and does not overwrite old evidence.
Reports contain configuration hashes and diagnostic codes, not executable arguments,
environment values or credentials. Exit 0 means the offline configuration checks passed;
the report still says `readyToExecute: false` because live authorization, Agent independence,
workspace choice and execution approval have not been established.

The planned mainline has three host ACP prompt turns: Boss delegation, Worker execution,
Boss synthesis. This preparation command does not enforce a runtime budget and cannot bound
provider requests hidden inside an Agent. Obtain approval for the selected Agents and the
actual bounded execution procedure before sending a real prompt. Real execution must use
new isolated data/workspace paths and preserve the old service and its data.

Do not enable or probe the example before adapter installation and initialization
are authorized. Initialization can start processes, load user configuration, and
access a network even without a model prompt. A local login-status result does
not prove online access, quota, or permission to consume that account.

For a later real-agent acceptance test, choose the provider/model, authorized auth
method, data scope and budget first. Use a separate workspace/database and review
the agent's configuration, skills and MCP sources. An empty cwd is not isolation;
LocalRunner is not an OS sandbox. Do not copy provider credentials into config,
task payloads or artifacts. Do not assume this disabled sample enforces read-only
mode or implements credential injection.
