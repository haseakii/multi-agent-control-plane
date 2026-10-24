type Identity = { turnId: string; agentId: string; attemptId: string };
type Progress = Identity & { text: string; truncated: boolean; state: string; artifactId?: string };
type Tool = Identity & { toolCallId: string; title: string; status: string };
function identity(value: unknown): value is Identity & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return ['turnId', 'agentId', 'attemptId'].every(
    (key) => typeof p[key] === 'string' && (p[key] as string).length > 0,
  );
}
function progress(value: unknown): value is Progress {
  return (
    identity(value) &&
    typeof value.text === 'string' &&
    value.text.length <= 4096 &&
    typeof value.truncated === 'boolean' &&
    ['streaming', 'complete', 'interrupted'].includes(String(value.state)) &&
    (value.artifactId === undefined || typeof value.artifactId === 'string')
  );
}
function toolRecord(value: unknown): value is Tool {
  return (
    identity(value) &&
    typeof value.toolCallId === 'string' &&
    value.toolCallId.length <= 128 &&
    typeof value.title === 'string' &&
    value.title.length <= 160 &&
    ['pending', 'in_progress', 'completed', 'failed'].includes(String(value.status))
  );
}
type Event = { id: string; taskId?: string; type: string; occurredAt: string; payload?: unknown };
export function agentActivity(events: Event[], taskIds: readonly string[]) {
  const ids = new Set(taskIds);
  const entries = new Map<
    string,
    {
      id: string;
      taskId: string;
      attemptId: string;
      agentId: string;
      at: number;
      text: string;
      state: string;
      kind: 'message' | 'tool';
      artifactId?: string;
      truncated?: boolean;
    }
  >();
  for (const event of events) {
    if (!event.taskId || !ids.has(event.taskId)) continue;
    if (!Number.isFinite(Date.parse(event.occurredAt))) continue;
    if (event.type === 'agent.progress' && progress(event.payload)) {
      const p = event.payload,
        key = `progress-${p.attemptId}-${p.turnId}`;
      const previous = entries.get(key);
      // A replay can reorder records sharing the same millisecond timestamp.
      if (
        previous &&
        ((['complete', 'interrupted'].includes(previous.state) && p.state === 'streaming') ||
          (previous.artifactId && !p.artifactId))
      )
        continue;
      entries.set(key, {
        id: key,
        taskId: event.taskId,
        attemptId: p.attemptId,
        agentId: p.agentId,
        at: entries.get(key)?.at ?? Date.parse(event.occurredAt),
        text: p.text,
        state: p.state,
        artifactId: p.artifactId,
        truncated: p.truncated,
        kind: 'message',
      });
    } else if (event.type === 'agent.tool' && toolRecord(event.payload)) {
      const p = event.payload,
        key = `tool-${p.attemptId}-${p.turnId}-${p.toolCallId}`;
      const previous = entries.get(key);
      if (
        previous &&
        ['completed', 'failed'].includes(previous.state) &&
        !['completed', 'failed'].includes(p.status)
      )
        continue;
      entries.set(key, {
        id: key,
        taskId: event.taskId,
        attemptId: p.attemptId,
        agentId: p.agentId,
        at: entries.get(key)?.at ?? Date.parse(event.occurredAt),
        text: p.title,
        state: p.status,
        kind: 'tool',
      });
    }
  }
  return [...entries.values()].sort((a, b) => a.at - b.at);
}
