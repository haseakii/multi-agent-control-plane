# ACP Agent Runtime

## Goal
Run arbitrary stdio ACP agents through a common protocol lifecycle while preserving agent-specific authentication and tools. Process supervision belongs to Runner; ACP session management belongs to the ACP runtime.

## V0 protocol policy
- ACP is the required runtime protocol.
- Implement the stable protocol path first.
- Protocol-version-specific behavior must be capability-gated behind the runtime adapter.
- Do not leak ACP JSON-RPC shapes into core domain packages.
- Treat authentication readiness as observed/best-effort; ACP v1 does not define a universal current-auth-status query.

## Runtime boundary

Runner owns process creation, termination, process status, and stdout/stderr. It returns an opaque process/transport handle. The ACP runtime connects to that handle and owns ACP initialization, session lifecycle, prompt streaming, updates, and cancellation.

```ts
interface Runner {
  spawn(spec: ProcessSpec): Promise<ProcessHandle>;
  stop(handle: ProcessHandle): Promise<void>;
  status(handle: ProcessHandle): Promise<ProcessStatus>;
  logs(handle: ProcessHandle): AsyncIterable<ProcessLog>;
}

interface AcpRuntime {
  connect(process: ProcessHandle): Promise<AcpConnection>;
  initialize(connection: AcpConnection): Promise<AgentProbeResult>;
  newSession(connection: AcpConnection, input: NewSessionInput): Promise<ConversationRef>;
  resumeSession(connection: AcpConnection, ref: ConversationRef, input: ResumeSessionInput): Promise<void>;
  prompt(ref: ConversationRef, input: PromptInput): AsyncIterable<AgentEvent>;
  cancel(ref: ConversationRef): Promise<void>;
}
```

An application service coordinates the two layers: spawn with Runner, connect/initialize with AcpRuntime, then persist the resulting runtime and conversation references. Stopping an ACP process is a Runner operation, not an ACP protocol operation.

## Authentication and readiness
Default auth mode is `agent-managed`:
1. The control plane starts/probes the ACP agent.
2. It records any `authMethods` advertised during initialization.
3. It uses explicit authentication flows when the agent supports them.
4. It records `auth_required` errors and other authentication evidence.
5. It stores only readiness metadata, never provider credentials in task/message/context/artifact payloads.

There is no universal current-auth-status query. Keep runtime health separate from auth readiness:

```ts
type RuntimeHealth = "unknown" | "ready" | "error";
type AuthReadiness = "unknown" | "needs_login" | "ready" | "not_reported";

type AgentReadiness = {
  runtime: RuntimeHealth;
  auth: AuthReadiness;
  observedAt?: string;
  evidence?: string[];
};
```

`ready` means the most recent supported initialization/session checks succeeded; it is not a promise that a credential cannot expire immediately afterward. If an agent cannot report auth state, use `unknown` or `not_reported`, not an inferred authenticated state.

Optional `secret-ref` is for agents that explicitly require injected environment variables. Secrets are resolved only at the runner/process boundary and never enter durable task/message/context/artifact payloads.

## Fleet MCP injection
For an ACP agent that supports session-level MCP configuration, the host supplies the Fleet MCP server through `mcpServers` when creating and resuming a session. The default V0 integration is a local stdio MCP server; only use another transport when the agent/runtime explicitly supports it.

The application service derives the tools exposed to a session from the configured bridge scopes, active project/task, and policy. Bridge calls must be authenticated as the calling agent/session, checked against project/task scope, and policy-evaluated on every call. Use short-lived, narrowly scoped bridge credentials or an equivalent process-bound identity; never reuse provider credentials. Reattach the same authorized bridge configuration on session resume.

If an agent does not support session MCP configuration, use its configured CLI or structured-command bridge only if that path is supported and validated. Otherwise set its bridge transport to `none`; it can still run as a worker, but cannot initiate control-plane bridge operations.

## Permission requests and enforcement
ACP permission requests are forwarded to the Policy/Approval layer when surfaced by the agent. Never blanket auto-approve them. This is cooperative mediation, not proof that every tool side effect is visible to the host. See [Security, Policy, and Approval](security.md) for enforcement modes and LocalRunner limitations.

## Events
Normalize protocol events into internal `AgentEvent` categories:
- lifecycle
- text_delta
- reasoning_summary (when available)
- tool
- permission_request
- artifact_hint
- status
- error
- completed

Raw provider events may be retained in the audit stream for diagnostics but are not the durable domain API.
