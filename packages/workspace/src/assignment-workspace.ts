import {
  AssignmentWorkspaceSchema,
  type Assignment,
  type AssignmentWorkspace,
  type ProjectWorkspaceConfig,
  type Task,
  type Workspace,
} from '@control-plane/core';

export interface AssignmentWorkspaceStore {
  getBinding(assignmentId: string): AssignmentWorkspace | undefined;
  getWorkspace(workspaceId: string): Workspace | undefined;
  saveBinding(binding: AssignmentWorkspace): void;
}
export interface AssignmentWorkspaceProvisioner {
  create(
    assignment: Assignment,
    task: Task,
    config: ProjectWorkspaceConfig,
    source: Workspace,
  ): Promise<Workspace>;
  validate(workspace: Workspace): Promise<void>;
  readPage?(workspace: Workspace): Promise<Uint8Array>;
}

/** Durable binding survives ACP sessions and retries; provisioning is an adapter concern. */
export class AssignmentWorkspaceService {
  constructor(
    private readonly store: AssignmentWorkspaceStore,
    private readonly provisioner: AssignmentWorkspaceProvisioner,
  ) {}

  async ensure(
    assignment: Assignment,
    task: Task,
    config: ProjectWorkspaceConfig,
    source: Workspace,
  ): Promise<Workspace> {
    const binding = this.store.getBinding(assignment.id);
    if (binding) {
      const workspace = this.store.getWorkspace(binding.workspaceId);
      if (
        !workspace ||
        binding.taskId !== task.id ||
        binding.projectId !== task.projectId ||
        workspace.projectId !== task.projectId
      )
        throw new Error('Saved assignment workspace is inconsistent.');
      await this.provisioner.validate(workspace);
      return workspace;
    }
    if (config.mode === 'unconfigured')
      throw new Error('Choose an execution workspace mode before starting new work.');
    const workspace =
      config.mode === 'shared-directory'
        ? source
        : await this.provisioner.create(assignment, task, config, source);
    await this.provisioner.validate(workspace);
    this.store.saveBinding(
      AssignmentWorkspaceSchema.parse({
        id: assignment.id,
        projectId: task.projectId,
        taskId: task.id,
        sourceWorkspaceId: source.id,
        workspaceId: workspace.id,
        mode: config.mode,
        createdAt: new Date().toISOString(),
      }),
    );
    return workspace;
  }
}
