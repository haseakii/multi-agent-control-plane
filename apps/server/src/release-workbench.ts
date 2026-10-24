import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Build metadata, not mutable user configuration. Classic releases have no descriptor.
export const ReleaseWorkbenchSchema = z
  .object({
    version: z.literal(1),
    workbench: z.literal('hermes'),
    mode: z.literal('real'),
    profile: z.literal('daily'),
    uiBuildId: z.string().datetime(),
  })
  .strict();

export function readReleaseWorkbench(webRoot: string) {
  const filename = join(webRoot, 'workbench.json');
  if (!existsSync(filename)) return undefined;
  return ReleaseWorkbenchSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
}
