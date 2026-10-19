import { AgentIdSchema, CapabilitySchema } from '@control-plane/core';
import type { AgentDefinition, AgentId, Capability } from '@control-plane/core';
import { z } from 'zod';
import type { AgentReadiness } from './types.js';
import { InMemoryAgentRegistry } from './registry.js';

export const CapabilityQuerySchema = z
  .object({
    exact: z.array(z.string().trim().min(1).max(128)).optional(),
    prefixes: z.array(z.string().trim().min(1).max(128)).optional(),
    custom: z.string().trim().min(1).max(256).optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (!(query.exact?.length || query.prefixes?.length || query.custom)) {
      context.addIssue({
        code: 'custom',
        message: 'At least one exact capability, prefix, or custom query is required.',
      });
    }
  });

export type CapabilityQuery = z.input<typeof CapabilityQuerySchema>;
export type CapabilityQueryContext = Readonly<Record<string, unknown>>;

export type CapabilitySelection = {
  agent: AgentDefinition;
  readiness: AgentReadiness;
  matchedCapabilities: Capability[];
  matchedExact: string[];
  matchedPrefixes: string[];
  customQueryMatched: boolean;
  score: number;
};

export type CapabilitySelectorOptions<TContext = CapabilityQueryContext> = {
  getReadiness: (agentId: AgentId) => AgentReadiness | undefined;
  /**
   * A routing eligibility filter only. It is not a security grant and must not
   * replace per-operation policy checks at the execution boundary.
   */
  policyAllows: (agent: AgentDefinition, context: TContext | undefined) => boolean;
  customCapabilityMatcher?: (capability: Capability, query: string) => boolean;
};

function isReady(readiness: AgentReadiness | undefined): readiness is AgentReadiness {
  return (
    readiness?.runtime === 'ready' &&
    (readiness.auth === 'ready' || readiness.auth === 'not_reported')
  );
}

/**
 * Capability-based agent discovery. Capabilities are routing metadata, not
 * authorization grants. Callers must still authorize each mediated operation.
 */
export class CapabilitySelector<TContext = CapabilityQueryContext> {
  constructor(
    private readonly registry: InMemoryAgentRegistry,
    private readonly options: CapabilitySelectorOptions<TContext>,
  ) {}

  registerCapability(agentId: string, capability: Capability): AgentDefinition {
    const id = AgentIdSchema.parse(agentId);
    return this.registry.registerCapability(id, CapabilitySchema.parse(capability));
  }

  unregisterCapability(agentId: string, capabilityName: string): AgentDefinition {
    const id = AgentIdSchema.parse(agentId);
    const name = z.string().trim().min(1).max(128).parse(capabilityName);
    return this.registry.unregisterCapability(id, name);
  }

  select(input: CapabilityQuery, context?: TContext): CapabilitySelection[] {
    const query = CapabilityQuerySchema.parse(input);
    if (query.custom && !this.options.customCapabilityMatcher) {
      throw new TypeError('A customCapabilityMatcher is required for custom capability queries.');
    }

    const exact = [...new Set(query.exact ?? [])];
    const prefixes = [...new Set(query.prefixes ?? [])];
    const results: CapabilitySelection[] = [];

    for (const agent of this.registry.list()) {
      if (!agent.enabled) {
        continue;
      }

      const readiness = this.options.getReadiness(agent.id);
      if (!isReady(readiness)) {
        continue;
      }

      if (!this.options.policyAllows(agent, context)) {
        continue;
      }

      const matchedExact = exact.filter((name) =>
        agent.capabilities.some((capability) => capability.name === name),
      );
      if (matchedExact.length !== exact.length) {
        continue;
      }

      const matchedPrefixes = prefixes.filter((prefix) =>
        agent.capabilities.some((capability) => capability.name.startsWith(prefix)),
      );
      if (matchedPrefixes.length !== prefixes.length) {
        continue;
      }

      const customMatches = query.custom
        ? agent.capabilities.filter((capability) =>
            this.options.customCapabilityMatcher?.(capability, query.custom!) ?? false,
          )
        : [];
      if (query.custom && customMatches.length === 0) {
        continue;
      }

      const matchedNames = new Set<string>([
        ...matchedExact,
        ...agent.capabilities
          .filter((capability) => prefixes.some((prefix) => capability.name.startsWith(prefix)))
          .map((capability) => capability.name),
        ...customMatches.map((capability) => capability.name),
      ]);
      const matchedCapabilities = agent.capabilities
        .filter((capability) => matchedNames.has(capability.name))
        .map((capability) => structuredClone(capability));

      results.push({
        agent,
        readiness: structuredClone(readiness),
        matchedCapabilities,
        matchedExact,
        matchedPrefixes,
        customQueryMatched: Boolean(query.custom && customMatches.length > 0),
        score: matchedCapabilities.length,
      });
    }

    results.sort(
      (left, right) =>
        right.score - left.score || left.agent.id.localeCompare(right.agent.id),
    );
    return results.slice(0, query.limit);
  }
}
