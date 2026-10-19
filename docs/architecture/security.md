# Security, Policy, and Approval

## Threat model
Agents are powerful, probabilistic, and potentially compromised by prompt injection. Treat model output, tool requests, external content, and agent-authored memory as untrusted.

## Trust boundaries
1. User/control-plane API boundary
2. Boss -> control bridge
3. Worker -> ACP client
4. Runner -> operating system
5. Workspace -> host filesystem
6. Agent -> network
7. Artifact/memory ingestion

## Authentication vs authorization
Agent authentication proves the external ACP agent can use its provider/account. It does not grant control-plane permissions.

Authorization is evaluated by the control-plane Policy Engine.

## Policy model
Actions resolve to `allow | ask | deny`.

Example policy:
```yaml
workspace:
  read: allow
  write: allow
  outsideWorkspace: deny

shell:
  default: allow
  dangerous: ask

network:
  default: ask

git:
  commit: allow
  push: ask
  forcePush: deny

packages:
  install: ask
```

## Approval
An `ask` action creates a durable Approval record. Execution pauses until approved/rejected/expired.

Approvals capture:
- requester agent
- task/assignment
- requested operation
- normalized parameters
- policy rule
- decision actor
- decision timestamp

## Secret handling
Default: provider credentials remain inside each agent's own auth mechanism.

When environment injection is unavoidable:
- store encrypted secret material through a SecretProvider
- AgentDefinition references `secret-ref`; it never contains cleartext
- secrets are scoped to runner/process
- secrets are omitted from logs/events/messages/artifacts

## Runner isolation
V0 LocalRunner is intentionally less isolated than a container/VM. Policy must expose that fact in UI. Post-V0 runners may provide stronger isolation.

## Prompt injection
The framework cannot eliminate prompt injection. It limits blast radius through:
- least privilege
- workspace boundaries
- approval gates
- capability/policy checks
- auditable routing
- immutable artifacts
- no automatic promotion to project memory
