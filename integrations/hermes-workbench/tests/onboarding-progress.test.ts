import { expect, it } from 'vitest';
import { connectionQueue, onboardingStatus, onboardingSummary } from '../src/onboarding-progress';
import { runConnectionBatch } from '../src/connection-batch';

const pending = { id: 'pending', selected: true, runtime: {} };
const saved = { definition: { enabled: true }, readiness: { runtime: 'ready', auth: 'ready' } };

it('retries only the requested member, even when skipped in the batch, without changing selection', async () => {
  const rows = [
    pending,
    { ...pending, id: 'skip', selected: false, error: 'failed' },
    { ...pending, id: 'done', done: true, saved },
  ];
  const before = JSON.stringify(rows);
  const calls: string[] = [];
  await runConnectionBatch(
    connectionQueue(rows, 'skip'),
    async (row) => {
      calls.push(row.id);
    },
    () => false,
    () => {},
  );
  expect(calls).toEqual(['skip']);
  expect(connectionQueue(rows).map((row) => row.id)).toEqual(['pending']);
  expect(JSON.stringify(rows)).toBe(before);
  expect(connectionQueue(rows, 'done')).toEqual([]);
  expect(connectionQueue(rows, 'missing')).toEqual([]);
});

it('separates ready members, login follow-up, and existing registrations', () => {
  expect(onboardingStatus({ ...pending, done: true, saved })).toBe('ready');
  expect(
    onboardingStatus({
      ...pending,
      done: true,
      saved: { ...saved, readiness: { runtime: 'ready', auth: 'not_reported' } },
    }),
  ).toBe('ready');
  expect(
    onboardingStatus({
      ...pending,
      done: true,
      saved: { ...saved, readiness: { runtime: 'ready', auth: 'needs_login' } },
    }),
  ).toBe('login');
  expect(onboardingStatus({ ...pending, done: true, existing: saved })).toBe('existing');
  expect(
    onboardingStatus({
      ...pending,
      done: true,
      saved: { ...saved, definition: { enabled: false } },
    }),
  ).toBe('disabled');
});

it('does not call an unvalidated repair ready because its saved member was previously ready', () => {
  expect(onboardingStatus({ ...pending, saved })).toBe('pending');
  expect(onboardingStatus({ ...pending, saved, error: 'connection failed' })).toBe('repair');
  expect(onboardingStatus({ ...pending, runtime: undefined })).toBe('repair');
  expect(connectionQueue([{ ...pending, runtime: undefined }])).toEqual([]);
});

it('summarizes mixed outcomes without treating existing or login-pending entries as usable', () => {
  expect(
    onboardingSummary([
      { ...pending, done: true, saved },
      {
        ...pending,
        done: true,
        saved: { ...saved, readiness: { runtime: 'ready', auth: 'unknown' } },
      },
      { ...pending, done: true, existing: saved },
      { ...pending, error: 'failed' },
      pending,
    ]),
  ).toBe('1 位可开始任务 · 1 位待确认登录 · 1 位已有成员 · 1 位需处理 · 1 位待检查');
});
