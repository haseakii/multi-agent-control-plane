import {
  PolicyEffectSchema,
  PolicyRequestSchema,
  PolicyRuleSchema,
  type ParsedPolicyRequest,
  type PolicyDecision,
  type PolicyEffect,
  type PolicyRequest,
  type PolicyRule,
} from './types.js';

function matches(pattern: string, action: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return action.startsWith(prefix);
  }
  return pattern === action;
}

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly defaultEffect: PolicyEffect;

  constructor(input: { rules: PolicyRule[]; defaultEffect?: PolicyEffect | undefined }) {
    this.rules = input.rules.map((rule) => PolicyRuleSchema.parse(rule));
    this.defaultEffect = PolicyEffectSchema.parse(input.defaultEffect ?? 'deny');
  }

  evaluate(input: PolicyRequest): PolicyDecision {
    const request = PolicyRequestSchema.parse(input);

    if (request.requiresEnforcedBoundary && request.enforcementMode !== 'enforced') {
      return {
        effect: 'deny',
        ruleId: '__strict_boundary__',
        enforcementMode: request.enforcementMode,
        boundary: request.boundary,
        reason: `Strict enforcement is required but boundary "${request.boundary}" is ${request.enforcementMode}.`,
      };
    }

    const rule = this.rules.find((candidate) => matches(candidate.actionPattern, request.action));
    if (rule) {
      return this.decisionFor(request, rule.effect, rule.id, rule.description);
    }

    return this.decisionFor(
      request,
      this.defaultEffect,
      '__default__',
      `Default policy for ${request.action} is ${this.defaultEffect}.`,
    );
  }

  private decisionFor(
    request: ParsedPolicyRequest,
    effect: PolicyEffect,
    ruleId: string,
    description?: string | undefined,
  ): PolicyDecision {
    return {
      effect,
      ruleId,
      enforcementMode: request.enforcementMode,
      boundary: request.boundary,
      reason: description ?? `Policy rule ${ruleId} resolved ${request.action} to ${effect}.`,
    };
  }
}
