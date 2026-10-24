/** UI submission state. Durable task and optimistic version remain server-owned. */
export interface DraftSubmission {
  projectId: string;
  taskId?: string;
  createKey?: string;
  creationObjective?: string;
}

interface DraftTask {
  id: string;
  objective: string;
}

export interface DraftRecord<T extends DraftTask> {
  task: T;
  version: string;
  canEditObjective: boolean;
  reason: string;
}

export interface DraftGateway<T extends DraftTask> {
  create(projectId: string, objective: string, idempotencyKey?: string): Promise<T>;
  read(taskId: string): Promise<DraftRecord<T>>;
  update(taskId: string, objective: string, version: string): Promise<DraftRecord<T>>;
  selectBoss?(projectId: string): Promise<unknown>;
  start(taskId: string, version: string): Promise<T>;
}

/** Reconcile a retry with its durable draft before starting the current goal.
 * Gateway methods validate HTTP responses; version conflicts stay visible to the user.
 */
export async function submitDraft<T extends DraftTask>(
  objective: string,
  submission: DraftSubmission,
  gateway: DraftGateway<T>,
  onChanged: () => void = () => {},
): Promise<T> {
  if (!submission.taskId) {
    submission.createKey ??= crypto.randomUUID();
    submission.creationObjective ??= objective;
    onChanged();
    const task = await gateway.create(
      submission.projectId,
      submission.creationObjective,
      submission.createKey,
    );
    submission.taskId = task.id;
    onChanged();
  }
  let record = await gateway.read(submission.taskId);
  if (!record.canEditObjective)
    throw new Error(record.reason || '目标已进入执行流程，请在原会话中补充要求。');
  if (record.task.objective !== objective) {
    record = await gateway.update(submission.taskId, objective, record.version);
    if (!record.canEditObjective || record.task.objective !== objective)
      throw new Error('未能确认最新目标已保存，任务尚未启动。请刷新后重试。');
  }
  // Re-select on each explicit send. A previous failed send or another window
  // may have changed the project's default; a cached boolean cannot confirm it.
  await gateway.selectBoss?.(submission.projectId);
  return gateway.start(submission.taskId, record.version);
}
