import { createHash, randomBytes } from 'node:crypto';
import type { AgentDefinition, BridgeScope } from '@control-plane/core';
import type {
  FleetBridgeGrant,
  FleetBridgeGrantIssuer,
  FleetBridgeGrantRequest,
} from './session-attachment.js';

export type FleetBridgeGrantResolution = {
  agentId: FleetBridgeGrantRequest['agentId'];
  projectId: string;
  taskId?: string | undefined;
  scopes: BridgeScope[];
  sessionId?: string | undefined;
  expiresAt: string;
};

export interface FleetBridgeGrantResolver {
  resolve(token: string): FleetBridgeGrantResolution;
}

type StoredGrant = FleetBridgeGrantResolution & {
  tokenHash: string;
  revoked: boolean;
};

export type InMemoryFleetBridgeGrantStoreOptions = {
  ttlMs?: number | undefined;
  now?: (() => Date) | undefined;
  tokenFactory?: (() => string) | undefined;
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class FleetBridgeGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetBridgeGrantError';
  }
}

export class InMemoryFleetBridgeGrantStore
  implements FleetBridgeGrantIssuer, FleetBridgeGrantResolver
{
  private readonly grants = new Map<string, StoredGrant>();
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;

  constructor(options: InMemoryFleetBridgeGrantStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
  }

  async issue(request: FleetBridgeGrantRequest): Promise<FleetBridgeGrant> {
    const token = this.tokenFactory();
    const hash = tokenHash(token);
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();

    this.grants.set(hash, {
      agentId: request.agentId,
      projectId: request.projectId,
      scopes: [...request.scopes],
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      expiresAt,
      tokenHash: hash,
      revoked: false,
    });

    return { token, expiresAt };
  }

  async bindSession(token: string, sessionId: string): Promise<void> {
    const grant = this.require(token);
    if (grant.sessionId !== undefined && grant.sessionId !== sessionId) {
      throw new FleetBridgeGrantError('Bridge grant is already bound to another ACP session.');
    }
    grant.sessionId = sessionId;
  }

  async revoke(token: string): Promise<void> {
    const grant = this.grants.get(tokenHash(token));
    if (grant) {
      grant.revoked = true;
    }
  }

  resolve(token: string): FleetBridgeGrantResolution {
    const grant = this.require(token);
    return {
      agentId: grant.agentId,
      projectId: grant.projectId,
      scopes: [...grant.scopes],
      ...(grant.taskId === undefined ? {} : { taskId: grant.taskId }),
      ...(grant.sessionId === undefined ? {} : { sessionId: grant.sessionId }),
      expiresAt: grant.expiresAt,
    };
  }

  private require(token: string): StoredGrant {
    const grant = this.grants.get(tokenHash(token));
    if (!grant || grant.revoked) {
      throw new FleetBridgeGrantError('Bridge grant is invalid or revoked.');
    }
    if (Date.parse(grant.expiresAt) <= this.now().getTime()) {
      throw new FleetBridgeGrantError('Bridge grant has expired.');
    }
    return grant;
  }
}

export type FleetBridgeManifest = {
  agent: AgentDefinition;
  scopes: BridgeScope[];
};
