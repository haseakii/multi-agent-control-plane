import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { AgentCatalogSourceSchema, AgentDefinitionSchema } from '@control-plane/core';
import { openSqliteStorage } from '@control-plane/storage';
import { AgentCatalogStatus } from './agent-catalog-status.js';
import { AgentCatalogService, OFFICIAL_CATALOG_URL, type CatalogEntry } from './agent-catalog.js';
import { AgentControlService, type RegisteredAgentView } from './agent-control.js';
import { discoverAgentEntries } from './agent-entry-discovery.js';
import { buildServer } from './server.js';

const at = '2026-10-25T00:00:00.000Z';
const entry: CatalogEntry = {
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: 'Inert catalog metadata',
  license_url: 'https://example.test/license',
  distribution: {
    binary: {
      'windows-x86_64': {
        archive: 'https://example.test/never-downloaded.zip',
        cmd: './sample.exe',
        args: ['--never-import'],
        env: { REGISTRY_SETTING: 'never-import' },
      },
    },
  },
};
const definition = (id: string, name = id) =>
  AgentDefinitionSchema.parse({
    id,
    name,
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/worker-agent.mjs', import.meta.url))],
    },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
function member(
  id: string,
  association?: 'linked' | 'entry-changed',
  name?: string,
): RegisteredAgentView {
  return {
    definition: definition(id, name),
    readiness: { runtime: 'ready', auth: 'ready', observedAt: at, authMethodIds: [] },
    authMethods: [],
    localEntry: { offlineChecksPassed: true, issues: [] },
    ...(association
      ? {
          registrationSource: {
            status: association,
            record: AgentCatalogSourceSchema.parse({
              entryId: entry.id,
              entryName: entry.name,
              catalogVersion: entry.version,
              catalogUrl: OFFICIAL_CATALOG_URL,
              agentId: id,
              revision: 1,
              runtimeFingerprint: 'a'.repeat(64),
              createdAt: at,
              updatedAt: at,
            }),
          },
        }
      : {}),
  };
}

it('expires local entry evidence on time, catalog version and platform changes without observing a process', () => {
  let now = Date.parse(at);
  const status = new AgentCatalogStatus(() => now, 5000);
  const candidate = {
    source: 'path' as const,
    name: 'Sample',
    runtime: definition('fixture').runtime,
  };
  const discovery = {
    candidates: [candidate],
    searchedDirectories: 1,
    note: 'Synthetic metadata only',
  };
  expect(status.read(entry, 'windows-x86_64').state).toBe('not-checked');
  const checked = status.record(entry, 'windows-x86_64', discovery, [], true);
  expect(checked).toMatchObject({
    state: 'found',
    candidateCount: 1,
    scope: 'selected-directory',
    checkedAt: at,
  });
  expect(status.read({ ...entry, version: '2.0.0' }, 'windows-x86_64').state).toBe('stale');
  expect(status.read(entry, 'linux-x86_64').state).toBe('stale');
  now += 5000;
  expect(status.read(entry, 'windows-x86_64')).toMatchObject({
    state: 'stale',
    checkedAt: at,
    candidateCount: 1,
  });
  status.record(entry, 'windows-x86_64', { ...discovery, candidates: [] }, []);
  expect(status.read(entry, 'windows-x86_64')).toMatchObject({
    state: 'not-found',
    candidateCount: 0,
    scope: 'common-locations',
  });
});

it('keeps explicit associations separate from possible matches and counts each registration once', () => {
  const explicit = member('explicit', 'linked', 'My chosen alias');
  const possible = member('possible', undefined, 'Sample');
  possible.definition.runtime.command = 'C:\\Installed\\sample.exe';
  possible.definition.runtime.args = [];
  const changed = member('changed', 'entry-changed', 'Sample');
  const offlineInvalid = member('invalid', undefined, 'Sample');
  offlineInvalid.localEntry = { offlineChecksPassed: false, issues: [] };
  const agents = [explicit, possible, changed, offlineInvalid];
  const discovery = discoverAgentEntries(entry, 'windows-x86_64', agents, {
    platform: 'win32',
    path: '',
    isFile: vi.fn(() => false),
  });
  expect(discovery.candidates.filter((candidate) => candidate.agentId === 'possible')).toHaveLength(
    1,
  );
  expect(
    discovery.candidates.map((candidate) => [candidate.agentId, candidate.association]),
  ).toEqual([
    ['explicit', 'linked'],
    ['possible', 'possible'],
    ['changed', 'possible'],
    ['invalid', 'possible'],
  ]);
  expect(JSON.stringify(discovery)).not.toContain('never-import');
  const status = new AgentCatalogStatus(() => Date.parse(at));
  status.record(entry, 'windows-x86_64', discovery, agents);
  expect(status.summaries([entry], 'windows-x86_64', agents)[0]).toMatchObject({
    registeredCount: 1,
    readyCount: 1,
    localEntryCount: 1,
    changedSourceCount: 1,
    localCheck: { state: 'found', candidateCount: 3 },
  });
});

function fixture() {
  const storage = openSqliteStorage({ filename: ':memory:' });
  storage.repositories.projects.upsert({
    id: 'p',
    name: 'Policy fixture',
    createdAt: at,
    updatedAt: at,
  });
  storage.repositories.projectPolicies.upsert({
    id: 'p',
    revision: 2,
    tools: {},
    gitMerge: 'ask',
    gitPush: 'deny',
    requireEnforcedExecution: false,
    agentPermissions: { workspaceFiles: 'auto', commands: 'ask', outsideWorkspace: 'ask' },
    updatedAt: at,
  });
  const observation = {
    readiness: {
      runtime: 'ready' as const,
      auth: 'ready' as const,
      observedAt: at,
      authMethodIds: [],
    },
    authMethods: [],
  };
  const runtime = {
    probe: vi.fn(async () => observation),
    authenticate: vi.fn(async () => observation),
  };
  const agents = new AgentControlService(storage, runtime, { now: () => at });
  let version = '1.0.0';
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ version: '1.0.0', agents: [{ ...entry, version }] }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const catalog = new AgentCatalogService(undefined, request);
  const app = buildServer({ agentControl: agents, agentCatalog: catalog });
  return {
    storage,
    runtime,
    agents,
    catalog,
    app,
    version(value: string) {
      version = value;
    },
    async close() {
      await app.close();
      storage.close();
    },
  };
}

it('requires catalog version consent for new registration and association while preserving bind-local compatibility', async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    const registered = definition('new', 'Explicit local configuration');
    const register = (payload: unknown) =>
      f.app.inject({ method: 'POST', url: '/api/agent-catalog/register', payload });
    expect((await register({ entryId: entry.id, definition: registered })).statusCode).toBe(400);
    expect(
      (
        await register({
          entryId: entry.id,
          expectedCatalogVersion: '0.9.0',
          definition: registered,
        })
      ).statusCode,
    ).toBe(409);
    expect(f.agents.list()).toEqual([]);
    const accepted = await register({
      entryId: entry.id,
      expectedCatalogVersion: '1.0.0',
      definition: registered,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({
      definition: registered,
      registrationSource: { status: 'linked', record: { catalogVersion: '1.0.0' } },
    });
    expect(accepted.json().definition.runtime.environmentAllowlist).toBeUndefined();
    const local = await f.app.inject({
      method: 'POST',
      url: '/api/agent-catalog/bind-local',
      payload: { entryId: entry.id, definition: definition('legacy') },
    });
    expect(local.statusCode, local.body).toBe(201);
    expect(local.json().definition.enabled).toBe(false);
    f.version('2.0.0');
    await f.catalog.refresh();
    const associate = (payload: unknown) =>
      f.app.inject({ method: 'POST', url: '/api/agent-catalog/associate', payload });
    const consent = {
      entryId: entry.id,
      agentId: 'new',
      expectedDefinitionHash: accepted.json().definitionHash,
      expectedRevision: 1,
    };
    expect((await associate(consent)).statusCode).toBe(400);
    expect((await associate({ ...consent, expectedCatalogVersion: '1.0.0' })).statusCode).toBe(409);
    expect(
      f.agents.list().find((agent) => agent.definition.id === 'new')?.registrationSource?.record
        ?.catalogVersion,
    ).toBe('1.0.0');
    const linked = await associate({ ...consent, expectedCatalogVersion: '2.0.0' });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().registrationSource.record).toMatchObject({
      catalogVersion: '2.0.0',
      revision: 2,
    });
    expect(f.runtime.probe).not.toHaveBeenCalled();
    expect(f.runtime.authenticate).not.toHaveBeenCalled();
    expect(f.storage.repositories.tasks.list()).toEqual([]);
    expect(f.storage.repositories.approvals.list()).toEqual([]);
  } finally {
    await f.close();
  }
});

it('treats provenance as user-selected metadata, preserves readiness and policy, and marks changed runtime entry', async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    const created = f.agents.create(definition('custom', 'Unrelated program alias'));
    const observed = await f.agents.probe('custom');
    f.runtime.probe.mockClear();
    const beforePolicy = f.storage.repositories.projectPolicies.get('p');
    const linked = await f.app.inject({
      method: 'POST',
      url: '/api/agent-catalog/associate',
      payload: {
        entryId: entry.id,
        expectedCatalogVersion: '1.0.0',
        agentId: 'custom',
        expectedDefinitionHash: created.definitionHash,
        expectedRevision: 0,
      },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().definition).toEqual(observed.definition);
    expect(linked.json().readiness).toEqual(observed.readiness);
    expect(linked.json().registrationSource.status).toBe('linked');
    const renamed = f.agents.update('custom', {
      expectedDefinitionHash: linked.json().definitionHash,
      name: 'Another user label',
    });
    expect(renamed.registrationSource?.status).toBe('linked');
    expect(renamed.readiness).toEqual(observed.readiness);
    const changed = f.agents.update('custom', {
      expectedDefinitionHash: renamed.definitionHash,
      runtime: {
        ...renamed.definition.runtime,
        args: [...renamed.definition.runtime.args, '--chosen-profile'],
      },
    });
    expect(changed.registrationSource?.status).toBe('entry-changed');
    expect(changed.registrationSource?.record?.revision).toBe(1);
    expect(f.storage.repositories.projectPolicies.get('p')).toEqual(beforePolicy);
    expect(f.runtime.probe).not.toHaveBeenCalled();
    expect(f.runtime.authenticate).not.toHaveBeenCalled();
    expect(f.storage.repositories.approvals.list()).toEqual([]);
  } finally {
    await f.close();
  }
});
