import {
  ProjectPolicySchema,
  ProjectToolActionSchema,
  type ProjectPolicy,
} from '@control-plane/core';
import { PolicyEngine } from './policy-engine.js';
import { PolicyRequestSchema, type PolicyRequest } from './types.js';
export interface ProjectPolicySource {
  get(projectId: string): ProjectPolicy;
}
/** Load current rules at each execution boundary, including after an asynchronous wait. */
export class ProjectPolicyEngine extends PolicyEngine {
  constructor(private readonly source: ProjectPolicySource) {
    super({ rules: [] });
  }
  override evaluate(input: PolicyRequest) {
    const request = PolicyRequestSchema.parse(input),
      policy = ProjectPolicySchema.parse(this.source.get(request.projectId));
    return new PolicyEngine({
      rules: [
        ...Object.entries(policy.tools).map(([actionPattern, effect]) => ({
          id: `project-${policy.revision}-${actionPattern}`,
          actionPattern,
          effect: effect!,
        })),
        {
          id: `project-${policy.revision}-git-merge`,
          actionPattern: 'git.merge',
          effect: policy.gitMerge,
        },
        { id: 'configured-workspace-write', actionPattern: 'workspace.write', effect: 'allow' },
        {
          id: `project-${policy.revision}-git-push`,
          actionPattern: 'git.push',
          effect: policy.gitPush,
        },
        ...ProjectToolActionSchema.options.map((actionPattern) => ({
          id: 'mediated-tools-default',
          actionPattern,
          effect: 'allow' as const,
        })),
      ],
    }).evaluate(request);
  }
}
