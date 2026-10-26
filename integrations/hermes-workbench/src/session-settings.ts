import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import type { SessionSettingValuesData } from './session-setting-values';
import {
  AgentSessionSettings,
  TaskSessionSettings,
  AgentSessionPresets,
  SessionPreset,
} from './session-settings-model';
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
const presetsPath = (agentId: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/session-presets`;
export const readAgentSessionPresets = (agentId: string, signal?: AbortSignal) =>
  fetchJSON(`${presetsPath(agentId)}?includeArchived=true`, { signal }, AgentSessionPresets);
export const createAgentSessionPreset = (
  agentId: string,
  id: string,
  name: string,
  values: SessionSettingValuesData,
  signal?: AbortSignal,
) =>
  fetchJSON(
    presetsPath(agentId),
    { method: 'POST', signal, body: JSON.stringify({ id, name, values }) },
    SessionPreset,
  );
export const renameAgentSessionPreset = (
  agentId: string,
  presetId: string,
  expectedRevision: number,
  name: string,
  signal?: AbortSignal,
) =>
  fetchJSON(
    `${presetsPath(agentId)}/${encodeURIComponent(presetId)}`,
    { method: 'PATCH', signal, body: JSON.stringify({ expectedRevision, name }) },
    SessionPreset,
  );
export const changeAgentSessionPresetArchive = (
  agentId: string,
  presetId: string,
  expectedRevision: number,
  archived: boolean,
  signal?: AbortSignal,
) =>
  fetchJSON(
    `${presetsPath(agentId)}/${encodeURIComponent(presetId)}/${archived ? 'archive' : 'restore'}`,
    { method: 'POST', signal, body: JSON.stringify({ expectedRevision }) },
    SessionPreset,
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
