import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';

describe('ACP approval binding forward migration', () => {
  it('upgrades the real six-migration database, expires only unbound pending ACP records, and preserves unrelated payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-migration-'));
    let storage: ReturnType<typeof openSqliteStorage> | undefined;
    try {
      const folder = join(root, 'old');
      mkdirSync(join(folder, 'meta'), { recursive: true });
      const journal = JSON.parse(
        readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
      );
      journal.entries = journal.entries.slice(0, 6);
      writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries)
        copyFileSync(
          new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
          join(folder, entry.tag + '.sql'),
        );
      const filename = join(root, 'state.sqlite');
      storage = openSqliteStorage({ filename, migrationsFolder: folder });
      const base = {
        projectId: 'project',
        action: 'acp.tool',
        resource: { legacy: 'unchanged' },
        enforcementMode: 'cooperative',
        boundary: 'acp-permission',
        requestedAt: '2026-10-21T00:00:00Z',
      };
      for (const [id, state, boundary] of [
        ['legacy', 'pending', 'acp-permission'],
        ['approved', 'approved', 'acp-permission'],
        ['other', 'pending', 'fleet-policy'],
      ])
        storage.repositories.approvals.upsert({ ...base, id, state, boundary });
      const originals = storage.sqlite
        .prepare('SELECT id,payload FROM approvals WHERE id != ? ORDER BY id')
        .all('legacy');
      storage.close();
      storage = openSqliteStorage({ filename });
      expect(storage.repositories.approvals.get('legacy')).toMatchObject({
        state: 'expired',
        expiryReason: 'legacy-acp-binding-missing',
      });
      expect(storage.repositories.approvals.get('legacy')?.acp).toBeUndefined();
      expect(
        storage.sqlite
          .prepare('SELECT id,payload FROM approvals WHERE id != ? ORDER BY id')
          .all('legacy'),
      ).toEqual(originals);
      expect(
        storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(),
      ).toEqual({ n: 23 });
      storage.close();
      storage = openSqliteStorage({ filename });
      expect(storage.repositories.approvals.get('legacy')?.state).toBe('expired');
    } finally {
      storage?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
