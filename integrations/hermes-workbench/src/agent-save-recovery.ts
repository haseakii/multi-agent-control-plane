import type { AgentConnectionData, AgentDefinitionData } from './agent-config';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('操作结果暂未确认，请刷新成员状态核对后再操作。已有输入仍保留。');
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Removal is confirmed only by its reply or an authoritative read showing absence. */
export async function removeAgentWithRecovery(
  agentId: string,
  write: (signal: AbortSignal) => Promise<unknown>,
  read: (signal: AbortSignal) => Promise<AgentConnectionData[]>,
  onChecking: () => void,
  timeoutMs = 15_000,
) {
  try {
    await bounded(write, timeoutMs);
  } catch (failure) {
    onChecking();
    try {
      const agents = await bounded(read, timeoutMs);
      if (!agents.some((agent) => agent.definition.id === agentId)) return;
    } catch {
      /* An unavailable list does not prove removal. Keep the original error. */
    }
    throw failure;
  }
}

/** A failed response is not proof that the write failed. Never retry a mutation here. */
export async function saveAgentWithRecovery(
  expected: AgentDefinitionData,
  write: (signal: AbortSignal) => Promise<AgentConnectionData>,
  read: (signal: AbortSignal) => Promise<AgentConnectionData[]>,
  onChecking: () => void,
  timeoutMs = 15_000,
) {
  try {
    return await bounded(write, timeoutMs);
  } catch (failure) {
    onChecking();
    try {
      const agents = await bounded(read, timeoutMs);
      const saved = agents.find((agent) => agent.definition.id === expected.id);
      if (
        saved &&
        JSON.stringify(canonical(saved.definition)) === JSON.stringify(canonical(expected))
      )
        return saved;
    } catch {
      /* Preserve the original failure and editor draft when confirmation is unavailable. */
    }
    throw failure;
  }
}
