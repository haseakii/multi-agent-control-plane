import { describe, expect, it } from 'vitest';
import {
  openSqliteStorage,
  PotentialSecretError,
  SensitiveApprovalReadError,
  ApprovalRecordIntegrityError,
  PermissionInspectionLimitError,
} from './index.js';

const base = {
  projectId: 'synthetic-project',
  action: 'acp.tool',
  boundary: 'acp-permission',
  resource: {},
  enforcementMode: 'cooperative',
  state: 'expired',
  requestedAt: '2026-10-21T00:00:00Z',
};
describe('sensitive approval read isolation', () => {
  it('keeps safe list/get available without exposing or changing unsafe records', () => {
    const storage = openSqliteStorage({ filename: ':memory:' });
    try {
      storage.repositories.approvals.upsert({ ...base, id: 'safe' });
      const unsafe = {
        ...base,
        id: 'unsafe',
        resource: {
          description:
            'Authorization: Basic ' +
            Buffer.from('synthetic-user:R3_SYNTHETIC_CANARY').toString('base64'),
        },
      };
      const payload = JSON.stringify(unsafe);
      storage.sqlite
        .prepare('INSERT INTO approvals(id,project_id,state,payload) VALUES(?,?,?,?)')
        .run(unsafe.id, unsafe.projectId, unsafe.state, payload);
      expect(storage.repositories.approvals.get('safe')?.id).toBe('safe');
      expect(() => storage.repositories.approvals.get('unsafe')).toThrow(PotentialSecretError);
      expect(storage.repositories.approvals.list().map((x) => x.id)).toEqual(['safe']);
      const result = storage.repositories.approvals.listWithDiagnostics();
      expect(result.diagnostics).toEqual({ code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED', count: 1 });
      expect(
        (
          storage.sqlite.prepare('SELECT payload FROM approvals WHERE id=?').get('unsafe') as {
            payload: string;
          }
        ).payload === payload,
      ).toBe(true);
      expect(() => storage.repositories.approvals.upsert({ ...base, id: 'unsafe' })).toThrow(
        SensitiveApprovalReadError,
      );
      expect(() => storage.repositories.approvals.delete('unsafe')).toThrow(
        SensitiveApprovalReadError,
      );
      expect(
        (
          storage.sqlite.prepare('SELECT payload FROM approvals WHERE id=?').get('unsafe') as {
            payload: string;
          }
        ).payload === payload,
      ).toBe(true);
      try {
        storage.repositories.approvals.get('unsafe');
      } catch (error) {
        expect(JSON.stringify(error).includes('CANARY')).toBe(false);
        expect((error as SensitiveApprovalReadError).code).toBe(
          'APPROVAL_SENSITIVE_RECORD_BLOCKED',
        );
      }
    } finally {
      storage.close();
    }
  });
  it.each(['invalid-json', 'invalid-schema', 'inspection-limit'])(
    'does not hide %s behind a successful isolated list',
    (mode) => {
      const storage = openSqliteStorage({ filename: ':memory:' });
      try {
        let resource: unknown = {};
        for (let i = 0; i < 20; i++) resource = { child: resource };
        const payload =
          mode === 'invalid-json'
            ? 'not JSON R3_SYNTHETIC_CANARY'
            : mode === 'invalid-schema'
              ? JSON.stringify({ id: 'broken', raw: 'R3_SYNTHETIC_CANARY' })
              : JSON.stringify({ ...base, id: 'broken', resource });
        storage.sqlite
          .prepare('INSERT INTO approvals(id,project_id,state,payload) VALUES(?,?,?,?)')
          .run('broken', base.projectId, base.state, payload);
        const errorType =
          mode === 'inspection-limit'
            ? PermissionInspectionLimitError
            : ApprovalRecordIntegrityError;
        expect(() => storage.repositories.approvals.list()).toThrow(errorType);
        expect(() => storage.repositories.approvals.get('broken')).toThrow(errorType);
        try {
          storage.repositories.approvals.list();
        } catch (error) {
          expect(String(error).includes('CANARY')).toBe(false);
        }
      } finally {
        storage.close();
      }
    },
  );
  it('propagates a real SQL failure instead of returning a healthy empty list', () => {
    const storage = openSqliteStorage({ filename: ':memory:' });
    storage.sqlite.exec('DROP TABLE approvals');
    try {
      expect(() => storage.repositories.approvals.listWithDiagnostics()).toThrow(/no such table/);
    } finally {
      storage.close();
    }
  });
});
