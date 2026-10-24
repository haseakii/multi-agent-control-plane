import {
  ExecutionContextSchema,
  type ExecutionContext,
  type Task,
  type Assignment,
  type ExecutionAttempt,
  type Project,
  type Workspace,
  type Artifact,
  type ProjectMemory,
} from '@control-plane/core';

/** Storage/blob access stays behind a port; the builder does not read the filesystem. */
export interface ContextSource {
  getProject(id: string): Project;
  listAcceptedMemory(projectId: string): ProjectMemory[];
  getTask(id: string): Task | undefined;
  listTasks(projectId: string): Task[];
  listAttempts(taskId: string): ExecutionAttempt[];
  getArtifact(id: string): Artifact | undefined;
  readTextArtifact(id: string): Promise<string>;
}

export class ContextBuilder {
  constructor(private readonly source: ContextSource) {}

  async build(
    task: Task,
    assignment: Assignment,
    attempt: ExecutionAttempt,
    workspace: Workspace,
  ): Promise<ExecutionContext> {
    const notes: string[] = [];
    const clip = (text: string, limit: number, label: string) => {
      if (text.length <= limit) return text;
      notes.push(
        `${label}: excerpt only; consult the referenced durable record for the full text.`,
      );
      return text.slice(0, limit);
    };
    const summary = (item: Task) => ({
      id: item.id,
      title: clip(item.title, 256, item.id),
      objective: clip(item.objective, 1500, item.id),
      state: item.state,
      resultArtifactRefs: item.resultArtifactRefs.slice(0, 32),
    });
    const requireTask = (id: string) => {
      const item = this.source.getTask(id);
      if (!item || item.projectId !== task.projectId)
        throw new Error('Referenced context task is unavailable in this project.');
      return item;
    };
    const dependencies = task.dependencyIds.slice(0, 16).map(requireTask);
    const children = this.source
      .listTasks(task.projectId)
      .filter((item) => item.parentTaskId === task.id && item.state === 'completed');
    if (task.dependencyIds.length > 16)
      notes.push('Only the first 16 dependency summaries are included.');
    if (children.length > 16)
      notes.push('Only the first 16 completed child summaries are included.');
    if (task.contextRefs.length > 32)
      throw new Error('Select at most 32 context artifact references.');
    const refs = new Map<string, 'selected' | 'dependency' | 'previous-result'>();
    for (const ref of task.contextRefs)
      refs.set(ref.startsWith('artifact:') ? ref.slice(9) : ref, 'selected');
    for (const dependency of dependencies)
      for (const id of dependency.resultArtifactRefs) if (!refs.has(id)) refs.set(id, 'dependency');
    for (const item of [task, ...children.slice(0, 16)])
      for (const id of item.resultArtifactRefs) if (!refs.has(id)) refs.set(id, 'previous-result');
    if (refs.size > 32)
      notes.push(
        'Additional result artifacts remain linked from their source tasks; 32 are included here.',
      );
    let remainingTextBytes = 16_000;
    const artifacts: ExecutionContext['artifacts'] = [];
    for (const [id, source] of [...refs].slice(0, 32)) {
      const artifact = this.source.getArtifact(id);
      if (!artifact || artifact.projectId !== task.projectId)
        throw new Error('Referenced context artifact is unavailable in this project.');
      const entry: ExecutionContext['artifacts'][number] = {
        id,
        source,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      };
      if (!(artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json')) {
        entry.contentOmitted = 'Non-text artifact; use its reference.';
      } else if (artifact.sizeBytes > 8_000 || artifact.sizeBytes > remainingTextBytes) {
        entry.contentOmitted = 'Content exceeds the context text budget; use its reference.';
      } else {
        entry.content = await this.source.readTextArtifact(id);
        remainingTextBytes -= artifact.sizeBytes;
      }
      artifacts.push(entry);
    }
    const project = this.source.getProject(task.projectId);
    const memory = this.source
      .listAcceptedMemory(task.projectId)
      .filter((item) => item.projectId === task.projectId && item.status === 'accepted')
      .sort((a, b) => {
        const priority = { constraint: 0, decision: 1, fact: 2, issue: 3 };
        return (
          priority[a.kind] - priority[b.kind] ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id)
        );
      });
    const acceptedMemory: ProjectMemory[] = [];
    let memoryBytes = 0;
    for (const item of memory) {
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (acceptedMemory.length >= 16 || memoryBytes + bytes > 24000) {
        notes.push(
          `Accepted memory ${item.id} omitted from this snapshot due to the 16-record / 24 KB budget.`,
        );
        continue;
      }
      acceptedMemory.push(item);
      memoryBytes += bytes;
    }
    return ExecutionContextSchema.parse({
      version: 1,
      taskId: task.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      project: {
        id: project.id,
        name: project.name,
        ...(project.description
          ? { description: clip(project.description, 2000, 'Project description') }
          : {}),
      },
      task: summary(task),
      acceptedMemory,
      ...(task.parentTaskId ? { parent: summary(requireTask(task.parentTaskId)) } : {}),
      dependencies: dependencies.map(summary),
      completedChildren: children.slice(0, 16).map(summary),
      workspace: {
        id: workspace.id,
        provider: workspace.provider,
        rootPath: workspace.rootPath,
        access: workspace.access,
        ...(workspace.baseRevision ? { baseRevision: workspace.baseRevision } : {}),
        ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
      },
      previousAttempts: this.source
        .listAttempts(task.id)
        .filter((item) => item.id !== attempt.id)
        .slice(-3)
        .map((item) => ({
          id: item.id,
          state: item.state,
          ...(item.failure ? { failure: clip(item.failure.message, 1000, item.id) } : {}),
        })),
      artifacts,
      notes,
    });
  }
}
