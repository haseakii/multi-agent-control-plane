import { z } from 'zod';

export const SessionSettingValues = z.record(z.string(), z.string().max(4096));
export type SessionSettingValuesData = z.infer<typeof SessionSettingValues>;

export function sameSessionValues(
  left?: SessionSettingValuesData,
  right?: SessionSettingValuesData,
) {
  if (left === undefined || right === undefined) return left === right;
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** A running instruction must use the already frozen execution settings. */
export function canApplyNextSessionSettings(taskEnded: boolean, executionActive: boolean) {
  return taskEnded && !executionActive;
}
