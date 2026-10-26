import { dirname, join } from 'node:path';
import { getClientMcpStdioPath } from '@control-plane/fleet-mcp';
import type { SqliteStorage } from '@control-plane/storage';
import type { ControlPlaneRuntime } from './runtime-composition.js';
import type { AgentCatalogService } from './agent-catalog.js';
import { AgentInstallationsService } from './agent-installations.js';
import { AgentMembersService } from './agent-members.js';
import { ExternalClientsService } from './external-clients.js';

/** Local services are available in both foreground and managed installations. */
export function createLocalIntegrations(options: {
  storage: SqliteStorage;
  runtime: ControlPlaneRuntime;
  catalog: AgentCatalogService;
  dataDir: string;
  releaseRoot: string;
  baseUrl: string;
  installationFile?: string;
  readLegacy?: () => unknown;
}) {
  const root = options.installationFile ? dirname(options.installationFile) : options.dataDir;
  const externalOptions = {
    storage: options.storage,
    runtime: options.runtime,
    baseUrl: options.baseUrl,
    readLegacy: options.readLegacy ?? (() => ({ version: 1, clients: [] })),
    ...(options.installationFile
      ? { installationFile: options.installationFile }
      : {
          localHost: {
            root,
            runtime: process.execPath,
            entry: getClientMcpStdioPath(),
          },
        }),
  };
  const externalClients = new ExternalClientsService(externalOptions);
  const agentMembers = new AgentMembersService(options.storage, options.runtime.agentControl);
  const agentInstallations = new AgentInstallationsService({
    storage: options.storage,
    catalog: options.catalog,
    agents: options.runtime.agentControl,
    network: options.runtime.network,
    root: join(root, 'agents'),
    releaseRoot: options.releaseRoot,
    members: agentMembers,
  });
  return {
    externalClients,
    agentMembers,
    agentInstallations,
    setBaseUrl: (url: string) => {
      externalOptions.baseUrl = url;
    },
  };
}
