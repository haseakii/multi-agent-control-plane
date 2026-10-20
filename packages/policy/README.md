# policy

V0 allow/ask/deny policy evaluation and durable approval gating.

Key properties:
- policy rules are evaluated outside agents;
- strict boundary requests fail closed unless enforcement is reported as `enforced`;
- `ask` persists an Approval and pauses the mediated operation until a user/system resolver decides it;
- `deny` cannot be overridden by Boss or worker text;
- approvals record the policy rule, enforcement mode, boundary, requester, task/assignment, and decision actor;
- `PolicyPermissionBroker` connects ACP permission requests to the same gate.

The policy engine only guarantees control over mediated operations. LocalRunner, LocalDirectory, and Git worktrees are not OS security sandboxes.
