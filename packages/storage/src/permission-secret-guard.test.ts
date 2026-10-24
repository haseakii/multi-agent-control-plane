import { describe, expect, it } from 'vitest';
import { openSqliteStorage, PotentialSecretError } from './index.js';

describe('ACP approval credential persistence backstop', () => {
  it.each(['basic', 'uppercase-url'])(
    'refuses unsafe %s values on both write and legacy read',
    (mode) => {
      const storage = openSqliteStorage({ filename: ':memory:' });
      const description =
        mode === 'basic'
          ? 'Authorization: Basic ' +
            Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64')
          : 'HTTPS://synthetic-user:ONLY_SYNTHETIC_URL_CANARY@example.test/file?key=ONLY_SYNTHETIC_QUERY_CANARY';
      const value = {
        id: 'synthetic-only',
        projectId: 'project',
        action: 'acp.tool',
        boundary: 'acp-permission',
        resource: { description },
        enforcementMode: 'cooperative',
        state: 'pending',
        requestedAt: '2026-10-21T00:00:00Z',
      };
      try {
        expect(() => storage.repositories.approvals.upsert(value)).toThrow(PotentialSecretError);
        expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({
          n: 0,
        });
        storage.sqlite
          .prepare('INSERT INTO approvals (id,project_id,state,payload) VALUES (?,?,?,?)')
          .run(value.id, value.projectId, value.state, JSON.stringify(value));
        expect(() => storage.repositories.approvals.get(value.id)).toThrow(PotentialSecretError);
        expect(storage.repositories.approvals.list()).toEqual([]);
        expect(storage.repositories.approvals.listWithDiagnostics().diagnostics).toEqual({
          code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED',
          count: 1,
        });
      } finally {
        storage.close();
      }
    },
  );
});
