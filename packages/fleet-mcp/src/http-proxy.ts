import { AgentDefinitionSchema } from '@control-plane/core';
import type { AgentDefinition } from '@control-plane/core';
import { createFleetMcpServer } from './server.js';
import type { FleetBridgeIdentity, FleetControlServices, FleetMcpServerOptions } from './types.js';

export type FleetBridgeProxyManifest = {
  identity: FleetBridgeIdentity;
  agent: AgentDefinition;
};

export type FleetBridgeHttpProxyOptions = {
  baseUrl: string;
  grant: string;
  fetchImpl?: typeof fetch | undefined;
};

type BridgeToolResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Fleet bridge proxy URL must use http or https.');
  }
  return parsed.href.replace(/\/$/, '');
}

export class FleetBridgeHttpProxy {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FleetBridgeHttpProxyOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async manifest(): Promise<FleetBridgeProxyManifest> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/fleet/manifest`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Fleet bridge manifest request failed with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as FleetBridgeProxyManifest;
    return {
      identity: structuredClone(payload.identity),
      agent: AgentDefinitionSchema.parse(payload.agent),
    };
  }

  services(): FleetControlServices {
    return {
      discoverAgents: (input) => this.call('control_discover_agents', input),
      getAgent: (input) => this.call('control_get_agent', input),
      createTask: (input) => this.call('control_create_task', input),
      delegateTask: (input) => this.call('control_delegate_task', input),
      getTask: (input) => this.call('control_get_task', input),
      waitTask: (input) => this.call('control_wait_task', input),
      sendMessage: (input) => this.call('control_send_message', input),
      publishArtifact: (input) => this.call('control_publish_artifact', input),
      getArtifact: (input) => this.call('control_get_artifact', input),
      requestApproval: (input) => this.call('control_request_approval', input),
      cancelTask: (input) => this.call('control_cancel_task', input),
    };
  }

  private async call(toolName: string, input: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/fleet/tool`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ toolName, input }),
    });
    const payload = (await response.json()) as BridgeToolResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(
        payload.error ?? `Fleet bridge tool request failed with HTTP ${response.status}.`,
      );
    }
    return payload.result;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.grant}`,
    };
  }
}

export async function createFleetMcpHttpProxyServer(
  options: FleetBridgeHttpProxyOptions,
): Promise<ReturnType<typeof createFleetMcpServer>> {
  const proxy = new FleetBridgeHttpProxy(options);
  const manifest = await proxy.manifest();
  const serverOptions: FleetMcpServerOptions = {
    identity: manifest.identity,
    agent: manifest.agent,
    services: proxy.services(),
    hooks: {
      // The parent control-plane gateway is the authoritative policy/audit boundary.
      authorize: async () => ({ allowed: true }),
      audit: async () => undefined,
    },
  };
  return createFleetMcpServer(serverOptions);
}

export function fleetProxyOptionsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): FleetBridgeHttpProxyOptions {
  const baseUrl = env.CONTROL_PLANE_BRIDGE_URL;
  const grant = env.CONTROL_PLANE_BRIDGE_GRANT;
  if (!baseUrl || !grant) {
    throw new TypeError(
      'CONTROL_PLANE_BRIDGE_URL and CONTROL_PLANE_BRIDGE_GRANT are required for Fleet MCP stdio proxy.',
    );
  }
  return { baseUrl, grant };
}
