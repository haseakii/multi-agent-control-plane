import { z } from 'zod';
import type { ControlCenterSnapshot } from './control-center.js';

export const ControlCenterQuery = z.object({
  view: z.literal('conversation').optional(),
  taskId: z.string().min(1).max(256).optional(),
});
export type ControlCenterReadOptions = z.infer<typeof ControlCenterQuery>;
const FollowUp = z.object({ conversationRootTaskId: z.string(), sourceTaskId: z.string() });

/** A read projection only. Keep the global conversation index and live approval state. */
export function conversationTaskIds(
  snapshot: Pick<ControlCenterSnapshot, 'tasks' | 'timeline'>,
  taskId?: string,
) {
  const tasks = new Map<string, ControlCenterSnapshot['tasks'][number]>(
    snapshot.tasks.map((task) => [task.id, task]),
  );
  const links = snapshot.timeline.flatMap((event) => {
    if (event.type !== 'task.followup.created' || !event.taskId) return [];
    const parsed = FollowUp.safeParse(event.payload);
    return parsed.success ? [{ taskId: event.taskId, ...parsed.data }] : [];
  });
  let root = taskId ? tasks.get(taskId) : undefined;
  const ancestors = new Set<string>();
  while (root?.parentTaskId && !ancestors.has(root.id)) {
    ancestors.add(root.id);
    root = tasks.get(root.parentTaskId);
  }
  const first = root
    ? (links.find((link) => link.taskId === root.id)?.conversationRootTaskId ?? root.id)
    : undefined;
  const ids = new Set(
    first
      ? [
          first,
          ...links
            .filter((link) => link.conversationRootTaskId === first)
            .map((link) => link.taskId),
        ]
      : [],
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of snapshot.tasks) {
      if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function conversationSnapshot(snapshot: ControlCenterSnapshot, taskId?: string) {
  const ids = conversationTaskIds(snapshot, taskId);
  return {
    ...snapshot,
    timelineScope: taskId ?? null,
    timeline: snapshot.timeline.filter(
      (event) =>
        event.type === 'task.followup.created' || (!!event.taskId && ids.has(event.taskId)),
    ),
  };
}
