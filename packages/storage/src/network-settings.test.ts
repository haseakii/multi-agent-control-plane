import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { AgentDefinitionSchema } from '@control-plane/core';
import {
  openSqliteStorage,
  SqliteNetworkSettingsRepository,
  NetworkSettingsConflictError,
} from './index.js';
const at = '2026-10-25T00:00:00.000Z';
const member = AgentDefinitionSchema.parse({
  id: 'worker',
  name: 'Worker',
  enabled: true,
  runtime: { type: 'acp-stdio', command: process.execPath, args: [] },
  capabilities: [],
  auth: { mode: 'agent-managed' },
  orchestration: { canBeBoss: false },
  controlBridge: { transport: 'none', scopes: [] },
});
it('upgrades eighteen migrations, preserves old records, and persists atomic settings with CAS and member cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'network-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined,
    second: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 18);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const item of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + item.tag + '.sql', import.meta.url),
        join(folder, item.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    storage.repositories.agentDefinitions.upsert(member);
    const before = storage.sqlite.prepare('SELECT * FROM agent_definitions').all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(
      storage.sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get(),
    ).toEqual({ count: 22 });
    expect(storage.sqlite.prepare('SELECT * FROM agent_definitions').all()).toEqual(before);
    let repo = new SqliteNetworkSettingsRepository(storage.sqlite, () => at);
    expect(repo.read()).toMatchObject({ revision: 0, global: { mode: 'unmanaged' }, members: {} });
    const saved = repo.save(0, {
      global: { mode: 'proxy', proxyUrl: '127.0.0.1:7897' },
      members: { worker: { mode: 'direct' } },
    });
    expect(saved).toMatchObject({
      revision: 1,
      global: { proxyUrl: 'http://127.0.0.1:7897' },
      members: { worker: { mode: 'direct' } },
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    repo = new SqliteNetworkSettingsRepository(storage.sqlite, () => at);
    expect(repo.read()).toEqual(saved);
    second = openSqliteStorage({ filename });
    const other = new SqliteNetworkSettingsRepository(second.sqlite, () => at);
    repo.save(1, { global: { mode: 'direct' }, members: { worker: { mode: 'inherit' } } });
    expect(() =>
      other.save(1, { global: { mode: 'proxy', proxyUrl: '127.0.0.1:7999' }, members: {} }),
    ).toThrow(NetworkSettingsConflictError);
    const current = repo.read();
    expect(() =>
      repo.save(2, {
        global: { mode: 'proxy', proxyUrl: '127.0.0.1:7999' },
        members: { missing: { mode: 'direct' } },
      }),
    ).toThrow();
    expect(repo.read()).toEqual(current);
    storage.sqlite.prepare('DELETE FROM agent_definitions WHERE id=?').run(member.id);
    expect(repo.read().members).toEqual({});
  } finally {
    if (second?.sqlite.open) second.close();
    if (storage?.sqlite.open) storage.close();
    const absolute = resolve(root);
    if (
      !absolute.startsWith(resolve(tmpdir()) + '\\network-migration-') &&
      !absolute.startsWith(resolve(tmpdir()) + '/network-migration-')
    )
      throw Error('Unexpected fixture root');
    rmSync(absolute, { recursive: true, force: true });
  }
});
it('rejects credential-bearing proxy addresses and does not silently reset malformed stored settings', () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  try {
    const repo = new SqliteNetworkSettingsRepository(storage.sqlite, () => at);
    expect(() =>
      repo.save(0, {
        global: {
          mode: 'proxy',
          proxyUrl: 'http://synthetic-user:synthetic-password@localhost:7897',
        },
        members: {},
      }),
    ).toThrow();
    expect(repo.read().revision).toBe(0);
    repo.save(0, { global: { mode: 'direct' }, members: {} });
    storage.sqlite
      .prepare("UPDATE network_settings SET global_json=? WHERE id='global'")
      .run('{"mode":"proxy","proxyUrl":"socks5://127.0.0.1:7897"}');
    expect(() => repo.read()).toThrow();
  } finally {
    storage.close();
  }
});
