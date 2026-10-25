import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  AgentCatalogSourceConflictError,
  openSqliteStorage,
  SqliteAgentCatalogSourcesRepository,
  SqliteSessionPresetsRepository,
  SqliteSessionSettingsRepository,
} from './index.js';

const at = '2026-10-25T00:00:00.000Z';
const later = '2026-10-25T01:00:00.000Z';
const fingerprint = 'a'.repeat(64);
const source = {
  entryId: 'local-agent',
  entryName: 'Local agent',
  catalogVersion: '2026.10',
  catalogUrl: 'https://example.test/catalog',
};
function register(storage: ReturnType<typeof openSqliteStorage>, id: string) {
  return storage.repositories.agentDefinitions.upsert({
    id,
    name: `Fixture ${id}`,
    enabled: false,
    runtime: { type: 'acp-stdio', command: 'never-run', args: [] },
    auth: { mode: 'agent-managed' },
    capabilities: [],
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
}
function removeFixture(root: string) {
  const target = resolve(root);
  if (!relative(resolve(tmpdir()), target).startsWith('catalog-sources-'))
    throw new Error('Unexpected fixture directory.');
  rmSync(target, { recursive: true, force: true });
}

it('upgrades seventeen migrations without changing prior payloads and retains associations through reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-sources-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const old = join(root, 'old');
    mkdirSync(join(old, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 17);
    writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(old, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: old });
    register(storage, 'agent');
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Preserved',
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.tasks.upsert({
      id: 'task',
      projectId: 'p',
      title: 'Preserve history',
      objective: 'Existing task context and changes remain',
      state: 'completed',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.approvals.upsert({
      id: 'approval',
      projectId: 'p',
      taskId: 'task',
      action: 'git.merge',
      resource: { path: 'page.html' },
      state: 'pending',
      enforcementMode: 'cooperative',
      requestedAt: at,
    });
    const settings = new SqliteSessionSettingsRepository(storage.sqlite);
    settings.saveDefaults('agent', 0, { model: 'retained' });
    settings.putTask({
      taskId: 'task',
      agentId: 'agent',
      requested: { model: 'retained' },
      state: 'applied',
      confirmed: { source: 'unavailable', options: [] },
    });
    new SqliteSessionPresetsRepository(storage.sqlite, () => at).create({
      id: '00000000-0000-4000-8000-000000000001',
      agentId: 'agent',
      name: 'Retained preset',
      values: { model: 'retained' },
    });
    const before = Object.fromEntries(
      [
        'agent_definitions',
        'tasks',
        'approvals',
        'agent_session_defaults',
        'task_session_settings',
        'agent_session_presets',
      ].map((table) => [table, storage!.sqlite.prepare(`SELECT * FROM ${table}`).all()]),
    );
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 19,
    });
    let sources = new SqliteAgentCatalogSourcesRepository(storage.sqlite);
    expect(sources.get('agent')).toBeUndefined();
    const saved = sources.save('agent', 0, source, fingerprint, at);
    storage.close();
    storage = openSqliteStorage({ filename });
    sources = new SqliteAgentCatalogSourcesRepository(storage.sqlite);
    expect(sources.get('agent')).toEqual(saved);
    for (const [table, rows] of Object.entries(before))
      expect(storage.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    expect(storage.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    removeFixture(root);
  }
});

it('uses two-connection CAS, isolates agents and cascades only the deleted registration association', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-sources-'));
  const filename = join(root, 'state.sqlite');
  const first = openSqliteStorage({ filename }),
    second = openSqliteStorage({ filename });
  try {
    register(first, 'a');
    register(first, 'b');
    const a = new SqliteAgentCatalogSourcesRepository(first.sqlite),
      b = new SqliteAgentCatalogSourcesRepository(second.sqlite);
    const initial = a.save('a', 0, source, fingerprint, at);
    const separate = b.save(
      'b',
      0,
      { ...source, entryName: 'Separate registration' },
      'b'.repeat(64),
      at,
    );
    expect(() => b.save('a', 0, source, fingerprint, later)).toThrow(
      AgentCatalogSourceConflictError,
    );
    const updated = b.save('a', 1, { ...source, catalogVersion: '2026.11' }, fingerprint, later);
    expect(updated).toMatchObject({
      revision: 2,
      createdAt: initial.createdAt,
      updatedAt: later,
      catalogVersion: '2026.11',
    });
    expect(a.get('a')).toEqual(updated);
    expect(a.get('b')).toEqual(separate);
    expect(() => a.save('unregistered', 0, source, fingerprint, at)).toThrow();
    expect(first.repositories.agentDefinitions.delete('a')).toBe(true);
    expect(a.get('a')).toBeUndefined();
    expect(b.get('b')).toEqual(separate);
    expect(first.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    first.close();
    second.close();
    removeFixture(root);
  }
});

it('rejects malformed or sensitive provenance on write and read, including inconsistent projections', () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  try {
    register(storage, 'agent');
    const sources = new SqliteAgentCatalogSourcesRepository(storage.sqlite);
    const synthetic = 'SYNTHETIC_PRIVATE_VALUE_ONLY_FOR_TEST';
    for (const changed of [
      { ...source, catalogUrl: 'https://example.test/catalog?token=synthetic' },
      { ...source, entryName: `Bearer ${synthetic}` },
      { ...source, executionPolicy: { commands: 'auto' } },
    ])
      expect(() => sources.save('agent', 0, changed, fingerprint, at)).toThrow();
    expect(sources.get('agent')).toBeUndefined();
    const saved = sources.save('agent', 0, source, fingerprint, at);
    const malformed = [
      '{',
      JSON.stringify({ ...saved, agentId: 'wrong-agent' }),
      JSON.stringify({ ...saved, runtimeFingerprint: 'invalid' }),
      JSON.stringify({ ...saved, entryName: `Bearer ${synthetic}` }),
      JSON.stringify({ ...saved, permissions: { autoApprove: true } }),
    ];
    for (const payload of malformed) {
      storage.sqlite
        .prepare('UPDATE agent_catalog_sources SET payload = ? WHERE agent_id = ?')
        .run(payload, 'agent');
      expect(() => sources.get('agent')).toThrow();
    }
    storage.sqlite
      .prepare('UPDATE agent_catalog_sources SET payload = ?, revision = ? WHERE agent_id = ?')
      .run(JSON.stringify(saved), 42, 'agent');
    expect(() => sources.get('agent')).toThrow();
  } finally {
    storage.close();
  }
});
