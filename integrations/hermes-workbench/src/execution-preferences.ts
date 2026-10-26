import { z } from 'zod';
import type { ExecutionMode } from './agent-selection';

export const executionPreferencesKey = 'control-plane-execution-preferences-v1';
const Preferences = z
  .object({
    version: z.literal(1),
    mode: z.enum(['direct', 'collaborative']),
    members: z
      .object({
        direct: z.string().max(256),
        collaborative: z.string().max(256),
      })
      .strict(),
  })
  .strict();
export type ExecutionPreferences = z.infer<typeof Preferences>;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readExecutionPreferences(
  getStore: () => Store = () => localStorage,
): ExecutionPreferences {
  try {
    const raw = getStore().getItem(executionPreferencesKey);
    if (raw && raw.length <= 2048) return Preferences.parse(JSON.parse(raw));
  } catch {
    /* Browser preferences must never prevent opening the workbench. */
  }
  return { version: 1, mode: 'direct', members: { direct: '', collaborative: '' } };
}

export function writeExecutionPreferences(
  value: ExecutionPreferences,
  getStore: () => Store = () => localStorage,
) {
  try {
    getStore().setItem(executionPreferencesKey, JSON.stringify(Preferences.parse(value)));
  } catch {
    /* The current selection remains usable without browser storage. */
  }
}

// Polling may fill an initial empty selection, but must never substitute another
// agent for a remembered selection, even if it is offline, disabled or removed.
export function fillInitialMember(
  value: ExecutionPreferences,
  candidateIds: string[],
): ExecutionPreferences {
  if (value.members[value.mode] || !candidateIds.length) return value;
  return chooseMember(value, candidateIds[0]!);
}

export function chooseMember(value: ExecutionPreferences, id: string): ExecutionPreferences {
  return { ...value, members: { ...value.members, [value.mode]: id } };
}

export function chooseExecutionMode(
  value: ExecutionPreferences,
  mode: ExecutionMode,
  candidateIds: string[],
) {
  return fillInitialMember({ ...value, mode }, candidateIds);
}
