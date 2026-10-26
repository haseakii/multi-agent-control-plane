import { z } from 'zod';
import type { AgentDefinitionData } from './agent-config';
import { sensitiveDraftValues } from './agent-onboarding-draft';

const Fields = z
  .object({
    id: z.string().max(128),
    name: z.string().max(4096),
    command: z.string().max(4096),
    args: z.array(z.string().max(8192)).max(128),
    cwd: z.string().max(4096),
    environment: z.string().max(16384),
    capabilities: z.string().max(16384),
    canBeBoss: z.boolean(),
    transport: z.enum(['mcp', 'cli', 'structured', 'none']),
    scopes: z
      .array(
        z.enum([
          'boss.orchestration',
          'agent.messaging',
          'artifact.read',
          'artifact.publish',
          'task.status',
          'knowledge.read',
          'memory.propose',
        ]),
      )
      .max(7),
  })
  .strict();
export type AgentEditorFields = z.infer<typeof Fields>;
export type AgentEditorRecovery = { base: AgentEditorFields; fields: AgentEditorFields };
export function reconcileEditorDraft(
  base: AgentEditorFields,
  fields: AgentEditorFields,
  latest: AgentEditorFields,
) {
  const merged = structuredClone(latest);
  const conflicts: (keyof AgentEditorFields)[] = [];
  for (const key of Object.keys(base) as (keyof AgentEditorFields)[]) {
    if (JSON.stringify(fields[key]) === JSON.stringify(base[key])) continue;
    if (
      JSON.stringify(latest[key]) !== JSON.stringify(base[key]) &&
      JSON.stringify(latest[key]) !== JSON.stringify(fields[key])
    )
      conflicts.push(key);
    Object.assign(merged, { [key]: fields[key] });
  }
  return { fields: merged, changed: JSON.stringify(base) !== JSON.stringify(latest), conflicts };
}
const Draft = z.object({ version: z.literal(1), base: Fields, fields: Fields }).strict();
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (id?: string) =>
  `control-plane-agent-editor-v1:${id === undefined ? 'new' : `agent:${encodeURIComponent(id)}`}`;

export function agentEditorFields(current?: AgentDefinitionData): AgentEditorFields {
  return {
    id: current?.id ?? `agent-${crypto.randomUUID()}`,
    name: current?.name ?? '',
    command: current?.runtime.command ?? '',
    args: current?.runtime.args ?? [],
    cwd: current?.runtime.cwd ?? '',
    environment: current?.runtime.environmentAllowlist?.join('\n') ?? '',
    capabilities: current?.capabilities.map((item) => item.name).join('\n') ?? '',
    canBeBoss: current?.orchestration.canBeBoss ?? false,
    transport: current?.controlBridge.transport ?? 'none',
    scopes: current?.controlBridge.scopes ?? [],
  };
}
const containsSensitive = (fields: AgentEditorFields) =>
  sensitiveDraftValues([
    fields.id,
    fields.name,
    fields.command,
    ...fields.args,
    fields.cwd,
    ...fields.environment
      .split(/[,，\r\n]/)
      .filter((value) => value.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())),
    fields.capabilities,
  ]);
export function clearAgentEditorDraft(storage: Store, id?: string) {
  try {
    storage.removeItem(key(id));
  } catch {
    /* optional storage */
  }
}
export function writeAgentEditorDraft(
  storage: Store,
  id: string | undefined,
  base: AgentEditorFields,
  fields: AgentEditorFields,
) {
  try {
    if (JSON.stringify(base) === JSON.stringify(fields)) {
      storage.removeItem(key(id));
      return 'empty' as const;
    }
    const data = Draft.parse({ version: 1, base, fields });
    if (containsSensitive(data.base) || containsSensitive(data.fields)) {
      storage.removeItem(key(id));
      return 'sensitive' as const;
    }
    const text = JSON.stringify(data);
    if (text.length > 262144) throw Error('Draft too large');
    storage.setItem(key(id), text);
    return 'saved' as const;
  } catch {
    clearAgentEditorDraft(storage, id);
    return 'unavailable' as const;
  }
}
export function readAgentEditorDraft(
  storage: Store,
  id: string | undefined,
  base: AgentEditorFields,
) {
  try {
    const text = storage.getItem(key(id));
    if (!text || text.length > 262144) return undefined;
    const data = Draft.parse(JSON.parse(text));
    if (
      containsSensitive(data.base) ||
      containsSensitive(data.fields) ||
      (id && (data.fields.id !== id || data.base.id !== id))
    )
      return undefined;
    return id
      ? reconcileEditorDraft(data.base, data.fields, base)
      : { fields: data.fields, changed: false, conflicts: [] };
  } catch {
    return undefined;
  }
}
