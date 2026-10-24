import {
  AgentIdSchema,
  AssignmentIdSchema,
  EnforcementModeSchema,
  JsonValueSchema,
  ProjectIdSchema,
  TaskIdSchema,
} from '@control-plane/core';
import type { Approval } from '@control-plane/core';
import { z } from 'zod';

export const PolicyEffectSchema = z.enum(['allow', 'ask', 'deny']);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const PolicyActionPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === '*' || !value.includes('*') || value.endsWith('.*'),
    'Policy wildcard is only supported as "*" or a trailing ".*".',
  );

export const PolicyRuleSchema = z
  .object({
    id: z.string().min(1).max(128),
    actionPattern: PolicyActionPatternSchema,
    effect: PolicyEffectSchema,
    description: z.string().max(512).optional(),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    assignmentId: AssignmentIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
    action: z.string().min(1).max(256),
    resource: JsonValueSchema,
    enforcementMode: EnforcementModeSchema,
    boundary: z.string().min(1).max(256),
    requiresEnforcedBoundary: z.boolean().default(false),
  })
  .strict();
export type PolicyRequest = z.input<typeof PolicyRequestSchema>;
export type ParsedPolicyRequest = z.output<typeof PolicyRequestSchema>;

export type PolicyDecision = {
  effect: PolicyEffect;
  ruleId: string;
  enforcementMode: z.infer<typeof EnforcementModeSchema>;
  boundary: string;
  reason: string;
};

export interface ApprovalStore {
  save(approval: Approval): Approval;
  get(id: string): Approval | undefined;
  listPending(projectId?: string): Approval[];
}

export type ApprovalServiceOptions = {
  now: () => string;
  idFactory: () => string;
  pollIntervalMs?: number | undefined;
  beforeResolve?: (approval: Approval, state: 'approved' | 'rejected') => void;
};

export type ApprovalWaitOptions = {
  pollIntervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type PolicyAuthorization =
  | { status: 'allowed'; decision: PolicyDecision }
  | { status: 'approval_required'; decision: PolicyDecision; approval: Approval };

export class PolicyDeniedError extends Error {
  constructor(
    readonly decision: PolicyDecision,
    message = decision.reason,
  ) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

export class ApprovalRejectedError extends Error {
  constructor(readonly approval: Approval) {
    super(`Approval ${approval.id} ended in state ${approval.state}.`);
    this.name = 'ApprovalRejectedError';
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval not found: ${id}`);
    this.name = 'ApprovalNotFoundError';
  }
}
