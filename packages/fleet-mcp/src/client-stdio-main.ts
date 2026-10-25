import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClientMcpServer, createClientHttpTransport } from './client-server.js';
import { BackgroundStartSchema, launchBackgroundHost } from './background-launch.js';
import { createEngineLifecycle } from './engine-lifecycle.js';
import { loopbackFetch } from './loopback-fetch.js';

export const ClientConnectionSchema = z
  .object({
    version: z.literal(1),
    baseUrl: z.string(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    start: BackgroundStartSchema.optional(),
  })
  .strict();
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--connection')
    throw new Error('Expected --connection LOCAL_FILE');
  const filename = resolve(args[1]!);
  const config = ClientConnectionSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
  const transport = createClientHttpTransport(config.baseUrl, config.token);
  const lifecycle = createEngineLifecycle({
    health: async () => {
      const response = await loopbackFetch(new URL('/health', config.baseUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      const value = (await response.json()) as { service?: string; status?: string };
      if (!response.ok || value.service !== 'multi-agent-control-plane' || value.status !== 'ok')
        throw new Error('Unexpected local service.');
    },
    ...(config.start ? { launch: () => launchBackgroundHost(filename) } : {}),
  });
  // Connect stdio immediately; engine warmup happens on demand and after outages.
  await createClientMcpServer({
    invoke: async (name, input) => {
      await lifecycle.ensure();
      // Never replay an uncertain mutation. Retain the task/idempotency key.
      return transport.invoke(name, input);
    },
  }).connect(new StdioServerTransport());
} catch {
  console.error(
    'Local collaboration MCP could not start. Check its connection file and the engine startup log.',
  );
  process.exitCode = 1;
}
