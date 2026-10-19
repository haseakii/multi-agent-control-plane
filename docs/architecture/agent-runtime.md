# ACP Agent Runtime

## Goal
Run arbitrary stdio ACP agents through a single lifecycle abstraction while preserving agent-specific authentication and tools.

## V0 protocol policy
- ACP is the required runtime protocol.
- Implement the stable protocol path first.
- Protocol-version-specific behavior must be capability-gated behind the runtime adapter.
- Do not leak ACP JSON-RPC shapes into core domain packages.

## Runtime interface

```ts
interface AgentRuntime {
  probe(definition: AgentDefinition): Promise<AgentProbeResult>;
  start(input: StartAgentInput): Promise<AgentProcessHandle>;
  stop(handle: AgentProcessHandle): Promise<void>;
  newSession(handle: AgentProcessHandle, input: NewSessionInput): Promise<ConversationRef>;
  resumeSession(handle: AgentProcessHandle, ref: ConversationRef): Promise<void>;
  prompt(ref: ConversationRef, input: PromptInput): AsyncIterable<AgentEvent>;
  cancel(ref: ConversationRef): Promise<void>;
}
```

## Authentication
Default mode is `agent-managed`:
1. Control plane starts/probes the ACP agent.
2. Agent reports auth/login requirements through its normal mechanism.
3. User authorizes that agent using the agent's own flow.
4. Control plane stores only status/metadata required to know whether the agent is ready.

Optional `secret-ref` is for agents that explicitly require injected environment variables. Secrets never enter Task, Message, Context, or Artifact payloads.

## Process lifecycle
A Runner owns OS process creation. The ACP runtime owns protocol handshake and session state. These are separate so the same runtime can later execute on LocalRunner, DockerRunner, SSHRunner, or RemoteRunner.

## Permission requests
Permission requests are forwarded to the Policy/Approval layer. V0 must never blanket auto-approve them.

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
