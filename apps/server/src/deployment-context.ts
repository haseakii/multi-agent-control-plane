import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
export const DeploymentContextSchema = z
  .object({
    installationId: z.uuid(),
    generationId: z.uuid(),
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    operationFile: z.string().refine(isAbsolute),
  })
  .strict();
export type DeploymentContext = z.infer<typeof DeploymentContextSchema>;
export function deploymentContext(value: string | undefined) {
  return value ? DeploymentContextSchema.parse(JSON.parse(value)) : undefined;
}
export function deploymentMaintenance(context: DeploymentContext | undefined) {
  return !!context && existsSync(context.operationFile);
}
export async function waitForDeployment(
  context: DeploymentContext | undefined,
  signal: AbortSignal,
) {
  while (!signal.aborted && deploymentMaintenance(context))
    try {
      await delay(250, undefined, { signal });
    } catch {
      break;
    }
}
