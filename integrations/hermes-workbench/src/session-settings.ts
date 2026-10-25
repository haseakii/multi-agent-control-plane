import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import type { SessionSettingValuesData } from './session-setting-values';
import { AgentSessionSettings, TaskSessionSettings } from './session-settings-model';
export * from './session-settings-model';
export {
  SessionSettingValues,
  sameSessionValues,
  type SessionSettingValuesData,
} from './session-setting-values';

const path = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/session-settings`;
export const readAgentSessionSettings = (
  agentId: string,
  projectId?: string,
  signal?: AbortSignal,
) =>
  fetchJSON(
    `${path(agentId)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    { signal },
    AgentSessionSettings,
  );
export const inspectAgentSessionSettings = (
  agentId: string,
  projectId?: string,
  values?: SessionSettingValuesData,
  signal?: AbortSignal,
) =>
  fetchJSON(
    path(agentId),
    { method: 'POST', signal, body: JSON.stringify({ projectId, values }) },
    AgentSessionSettings,
  );
export const saveAgentSessionDefaults = (
  agentId: string,
  expectedRevision: number,
  values: SessionSettingValuesData,
  signal?: AbortSignal,
) =>
  fetchJSON(
    `${path(agentId)}/defaults`,
    { method: 'PUT', signal, body: JSON.stringify({ expectedRevision, values }) },
    z.unknown(),
  );
export const readTaskSessionSettings = (taskId: string, signal?: AbortSignal) =>
  fetchJSON(
    `/api/tasks/${encodeURIComponent(taskId)}/session-settings`,
    { signal },
    TaskSessionSettings,
  );

export async function readTaskExecutionActive(taskId: string, signal?: AbortSignal) {
  const value = await fetchJSON(
    `/api/tasks/${encodeURIComponent(taskId)}/recovery`,
    { signal },
    z.object({ diagnostic: z.object({ executionActive: z.boolean() }) }),
  );
  return value.diagnostic.executionActive;
}
