import { z } from 'zod';
import type { CatalogEntry } from './agent-catalog.js';
import type { RegisteredAgentView } from './agent-control.js';
import type { EntryDiscoverySchema } from './agent-entry-discovery.js';

export const CatalogLocalCheckSchema = z
  .object({
    entryId: z.string().min(1).max(128),
    state: z.enum(['not-checked', 'found', 'not-found', 'stale']),
    checkedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    candidateCount: z.number().int().nonnegative().max(4096).optional(),
    scope: z.enum(['common-locations', 'selected-directory']).optional(),
  })
  .strict();
export const CatalogMemberStatusSchema = z
  .object({
    entryId: z.string().min(1).max(128),
    registeredCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    localEntryCount: z.number().int().nonnegative(),
    changedSourceCount: z.number().int().nonnegative(),
    localCheck: CatalogLocalCheckSchema,
  })
  .strict();

/** Ephemeral, bounded filesystem observations; never login or program-execution evidence. */
export class AgentCatalogStatus {
  private readonly checks = new Map<
    string,
    { version: string; platform: string; check: z.infer<typeof CatalogLocalCheckSchema> }
  >();
  constructor(
    private readonly now = () => Date.now(),
    private readonly ttlMs = 5 * 60_000,
  ) {}
  record(
    entry: CatalogEntry,
    platform: string,
    discovery: z.infer<typeof EntryDiscoverySchema>,
    agents: RegisteredAgentView[],
    selectedDirectory = false,
  ) {
    const validRegistered = new Set<string>(
      agents.filter((a) => a.localEntry?.offlineChecksPassed).map((a) => a.definition.id),
    );
    const count = discovery.candidates.filter(
      (candidate) =>
        candidate.source !== 'registered' ||
        (candidate.agentId && validRegistered.has(candidate.agentId)),
    ).length;
    const check = CatalogLocalCheckSchema.parse({
      entryId: entry.id,
      state: count ? 'found' : 'not-found',
      candidateCount: count,
      checkedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      scope: selectedDirectory ? 'selected-directory' : 'common-locations',
    });
    this.checks.delete(entry.id);
    this.checks.set(entry.id, { version: entry.version, platform, check });
    if (this.checks.size > 128) this.checks.delete(this.checks.keys().next().value!);
    return check;
  }
  read(entry: CatalogEntry, platform: string) {
    const cached = this.checks.get(entry.id);
    if (!cached) return CatalogLocalCheckSchema.parse({ entryId: entry.id, state: 'not-checked' });
    const stale =
      cached.version !== entry.version ||
      cached.platform !== platform ||
      Date.parse(cached.check.expiresAt!) <= this.now();
    return CatalogLocalCheckSchema.parse({
      ...cached.check,
      state: stale ? 'stale' : cached.check.state,
    });
  }
  summaries(entries: CatalogEntry[], platform: string, agents: RegisteredAgentView[]) {
    return entries.map((entry) => {
      const associated = agents.filter((a) => a.registrationSource?.record?.entryId === entry.id);
      const linked = associated.filter((a) => a.registrationSource?.status === 'linked');
      return CatalogMemberStatusSchema.parse({
        entryId: entry.id,
        registeredCount: linked.length,
        readyCount: linked.filter(
          (a) =>
            a.definition.enabled && a.readiness.runtime === 'ready' && a.readiness.auth === 'ready',
        ).length,
        localEntryCount: linked.filter((a) => a.localEntry?.offlineChecksPassed).length,
        changedSourceCount: associated.length - linked.length,
        localCheck: this.read(entry, platform),
      });
    });
  }
}
