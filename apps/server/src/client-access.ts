import { createHash, timingSafeEqual } from 'node:crypto';
import { ProjectIdSchema, ProjectToolActionSchema, type ProjectPolicy } from '@control-plane/core';
import {
  ClientAccessFileSchema,
  ClientToolNameSchema,
  type ClientAccess,
  type ClientToolName,
} from '@control-plane/fleet-mcp';
import { TaskControlError } from './task-control-error.js';

export type ClientPolicyAction = keyof ProjectPolicy['tools'];

/** Shared by upload and tool ingress; no grant snapshot survives a later check. */
export class ClientAccessGuard {
  constructor(
    private readonly readAccess: () => unknown,
    private readonly readPolicy: (projectId: string) => Pick<ProjectPolicy, 'tools'>,
  ) {}

  private clients(): ClientAccess[] {
    try {
      return ClientAccessFileSchema.parse(this.readAccess()).clients;
    } catch {
      throw new TaskControlError(503, 'Local client access configuration is unavailable.');
    }
  }

  authenticate(authorization: string | undefined): ClientAccess {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '')?.[1];
    const hash = createHash('sha256')
      .update(token ?? '')
      .digest();
    const clients = this.clients();
    const client = token
      ? clients.find(
          (candidate) =>
            candidate.enabled && timingSafeEqual(hash, Buffer.from(candidate.tokenSha256, 'hex')),
        )
      : undefined;
    if (!client) throw new TaskControlError(401, 'Local client access is missing or revoked.');
    return client;
  }

  authorize(
    identity: ClientAccess,
    rawTool: ClientToolName,
    rawProjectId: string,
    rawActions: readonly ClientPolicyAction[],
  ) {
    const tool = ClientToolNameSchema.parse(rawTool);
    const projectId = ProjectIdSchema.parse(rawProjectId);
    const actions = ProjectToolActionSchema.array().parse(rawActions);
    const client = this.clients().find(
      (candidate) =>
        candidate.id === identity.id &&
        candidate.enabled &&
        candidate.tokenSha256 === identity.tokenSha256,
    );
    if (!client || !client.tools.includes(tool))
      throw new TaskControlError(403, 'Client access changed while the operation was in progress.');
    const project = client.projects.find((grant) => grant.projectId === projectId);
    if (!project) throw new TaskControlError(403, 'Project is not authorized for this client.');
    const policy = this.readPolicy(projectId);
    if (actions.some((action) => policy.tools[action] === 'deny'))
      throw new TaskControlError(403, 'Current project policy denies this operation.');
    return project;
  }
}
