import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStorage } from './database.js';
it('upgrades twenty-one migrations, backfills grant revisions and preserves installation jobs and member origins', () => {
  const root = mkdtempSync(join(tmpdir(), 'member-connections-migration-')),
    folder = join(root, 'old'),
    filename = join(root, 'state.sqlite');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const directory = resolve('packages/storage/drizzle'),
    journal = JSON.parse(readFileSync(join(directory, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 21);
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const row of journal.entries)
    copyFileSync(join(directory, row.tag + '.sql'), join(folder, row.tag + '.sql'));
  let storage = openSqliteStorage({ filename, migrationsFolder: folder });
  const at = '2026-10-25T00:00:00Z';
  try {
    const client = {
      id: 'old',
      access: {
        id: 'old',
        name: 'Keep client',
        enabled: false,
        tokenSha256: 'b'.repeat(64),
        projects: [{ projectId: 'p' }],
        tools: ['collaboration_list_projects'],
      },
      target: 'generic',
      profile: 'read',
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      createdAt: at,
    };
    storage.sqlite
      .prepare('INSERT INTO external_clients(id,payload) VALUES(?,?)')
      .run(client.id, JSON.stringify(client));
    const jobId = randomUUID();
    storage.repositories.agentInstallations.upsert({
      id: jobId,
      entryId: 'fixture',
      version: '1.0.0',
      planHash: 'a'.repeat(64),
      state: 'failed',
      message: 'Keep recovery evidence',
      agentId: 'existing-agent',
      createdAt: at,
      updatedAt: at,
    });
    const before = storage.sqlite.prepare('SELECT * FROM agent_installations').all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.sqlite.prepare('SELECT * FROM agent_installations').all()).toEqual(before);
    const oldJob = storage.repositories.agentInstallations.get(jobId)!;
    expect(oldJob.directory).toBeUndefined();
    // Additive JSON metadata: old rows remain readable without a destructive backfill.
    const installDirectory = join(root, 'agents', '中文 installation');
    storage.repositories.agentInstallations.upsert({
      ...oldJob,
      directory: installDirectory,
      state: 'cancelled',
    });
    expect(storage.repositories.externalClients.get('old')).toMatchObject({
      revision: 1,
      access: { tokenSha256: client.access.tokenSha256, enabled: false },
    });
    expect(
      storage.sqlite
        .prepare(
          "SELECT json_extract(payload,'$.revision') AS revision FROM external_clients WHERE id='old'",
        )
        .get(),
    ).toEqual({ revision: 1 });
    const requestId = randomUUID();
    storage.repositories.agentMemberOrigins.upsert({
      id: 'member-' + requestId,
      requestId,
      requestHash: 'a'.repeat(64),
      sourceAgentId: 'existing-agent',
      runtimeFingerprint: 'c'.repeat(64),
      createdAt: at,
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.agentInstallations.get(jobId)?.directory).toBe(installDirectory);
    expect(storage.repositories.agentInstallations.get(jobId)?.state).toBe('cancelled');
    expect(storage.repositories.agentMemberOrigins.get('member-' + requestId)?.sourceAgentId).toBe(
      'existing-agent',
    );
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 22,
    });
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
