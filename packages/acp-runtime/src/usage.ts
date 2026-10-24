import { z } from 'zod';
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PromptUsageSchema = z.object({
  inputTokens: Count.nullish(),
  outputTokens: Count.nullish(),
  totalTokens: Count.nullish(),
  cachedReadTokens: Count.nullish(),
  cachedWriteTokens: Count.nullish(),
  thoughtTokens: Count.nullish(),
});
export type PromptUsage = Partial<Record<keyof z.infer<typeof PromptUsageSchema>, number>>;
/** Missing or invalid counters stay unknown; do not infer a cache hit. */
export function promptUsage(value: unknown): PromptUsage | undefined {
  const result = PromptUsageSchema.safeParse(value);
  if (!result.success) return undefined;
  const usage = Object.fromEntries(
    Object.entries(result.data).filter(([, value]) => typeof value === 'number'),
  ) as PromptUsage;
  return Object.keys(usage).length ? usage : undefined;
}
