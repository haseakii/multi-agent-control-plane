import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceIdSchema, WorkspaceSchema } from '@control-plane/core';
import type { Workspace } from '@control-plane/core';
import type { PolicyGate } from '@control-plane/policy';
import type { SqliteStorage } from '@control-plane/storage';
import {
  LocalDirectoryWorkspaceInputSchema,
  type LocalDirectoryWorkspaceInput,
  type WorkspaceIdFactory,
} from './types.js';

export class LocalDirectoryWorkspaceProvider {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly policy: PolicyGate,
    private readonly idFactory: WorkspaceIdFactory,
  ) {}

  async create(input: LocalDirectoryWorkspaceInput): Promise<Workspace> {
    const parsed = LocalDirectoryWorkspaceInputSchema.parse(input);
    const rootPath = await realpath(resolve(parsed.rootPath));
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      throw new TypeError(`Workspace root is not a directory: ${rootPath}`);
    }

    return this.policy.run(
      {
        projectId: parsed.projectId,
        taskId: parsed.taskId,
        requesterAgentId: parsed.requesterAgentId,
        action: parsed.access === 'read-write' ? 'workspace.write' : 'workspace.read',
        resource: {
          provider: 'local-directory',
          rootPath,
          access: parsed.access,
        },
        enforcementMode: 'unavailable',
        boundary: 'local-directory',
        requiresEnforcedBoundary: parsed.requiresEnforcedBoundary,
      },
      async () => {
        const workspace = WorkspaceSchema.parse({
          id: parsed.id ?? WorkspaceIdSchema.parse(this.idFactory()),
          projectId: parsed.projectId,
          provider: 'local-directory',
          rootPath,
          access: parsed.access,
        });
        return this.storage.repositories.workspaces.upsert(workspace);
      },
    );
  }
}
