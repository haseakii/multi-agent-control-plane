# Security, Policy, and Approval

## Threat model
Agents are powerful, probabilistic, and potentially compromised by prompt injection. Treat model output, tool requests, external content, and agent-authored memory as untrusted.

## Trust boundaries
1. User/control-plane API boundary
2. Boss/worker -> Control Bridge
3. Worker -> ACP client
4. Runner -> operating system
5. Workspace -> host filesystem
6. Agent -> network
7. Artifact/memory ingestion

## Authentication vs authorization
Agent authentication proves the external ACP agent can use its provider/account. It does not grant control-plane permissions.

Authorization is evaluated by the control-plane Policy Engine on every control-plane API/bridge operation. Bridge scopes are an upper bound on exposed tools, not a substitute for policy checks.

## What policy can actually enforce
The control plane can enforce operations that pass through its own API, Control Bridge, workspace/Git services, artifact store, and ACP permission requests that the agent actually surfaces to the host.

ACP does not guarantee that every agent-internal tool call or side effect is mediated by the host. An agent may run its own shell, filesystem, or network tools inside its process. LocalRunner runs with the operating-system permissions of its user; a Git worktree is not a sandbox. In those cases, the control plane cannot reliably block direct side effects merely by recording an `allow | ask | deny` policy.

Every policy evaluation should record an enforcement mode:
- `enforced`: the operation passes through a control-plane gate or a verified OS/runtime isolation boundary.
- `cooperative`: enforcement depends on an agent/adapter surfacing and honoring a permission request.
- `unavailable`: the requested boundary cannot be guaranteed by this runner/adapter.

If a task requires a strict boundary and the selected runner/adapter reports `unavailable`, fail closed and refuse to start it. Do not present cooperative enforcement as a security guarantee.

## Policy model
Actions resolve to `allow | ask | deny`.

Example defaults for mediated operations:
```yaml
workspace:
  read: allow
  write: ask
  outsideWorkspace: deny

shell:
  default: ask
  unmediated: deny

network:
  default: ask

git:
  commit: ask
  push: ask
  forcePush: deny

packages:
  install: ask
```

These defaults only protect operations that are actually mediated. They do not magically intercept an opaque agent's own tools. If direct tool access is required, either run the agent in an appropriate OS/container sandbox or clearly mark the task as running without strict enforcement and obtain explicit user acknowledgement.

## Approval
An `ask` action creates a durable Approval record. The control plane pauses the operation it controls until approved/rejected/expired. It cannot pause an unobserved side effect that bypasses its boundary.

Approvals capture:
- requester agent
- task/assignment
- requested operation
- normalized parameters
- policy rule
- enforcement mode and boundary
- decision actor
- decision timestamp

## Secret handling
Default: provider credentials remain inside each agent's own auth mechanism.

When environment injection is unavoidable:
- store encrypted secret material through a SecretProvider
- AgentDefinition references `secret-ref`; it never contains cleartext
- secrets are scoped to runner/process
- secrets are omitted from logs/events/messages/artifacts
- bridge credentials are short-lived and scoped to agent, project, task, and permitted tool scopes; never reuse provider credentials as bridge credentials

## Runner isolation
V0 LocalRunner is intentionally less isolated than a container/VM. The UI must show this limitation and must not claim strict workspace/network enforcement. Post-V0 isolated runners may provide stronger guarantees.

## Prompt injection
The framework cannot eliminate prompt injection. It limits blast radius through:
- least privilege
- workspace boundaries where enforced
- approval gates for mediated actions
- capability/policy checks
- auditable routing
- immutable artifacts
- no automatic promotion to project memory
