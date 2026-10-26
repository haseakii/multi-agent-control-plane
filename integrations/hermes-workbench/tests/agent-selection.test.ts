import { expect, it } from 'vitest';
import {
  selectableAgents,
  memberUnavailableReason,
  usableOnboardingMember,
  type Member,
} from '../src/agent-selection';
it('lets ordinary ready agents work directly while keeping orchestration opt-in', () => {
  const worker = {
    definition: {
      enabled: true,
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    },
    readiness: { runtime: 'ready', auth: 'ready' },
  };
  const boss = {
    ...worker,
    definition: {
      ...worker.definition,
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    },
  };
  const unknown = { ...worker, readiness: { runtime: 'ready', auth: 'unknown' } };
  const disabled = { ...worker, definition: { ...worker.definition, enabled: false } };
  expect(selectableAgents([worker, boss, unknown, disabled], 'direct')).toEqual([worker, boss]);
  expect(selectableAgents([worker, boss, unknown, disabled], 'collaborative')).toEqual([boss]);
  expect(worker.definition.orchestration.canBeBoss).toBe(false);
});

it('explains the actual blocking condition without claiming a connection failure means login expired', () => {
  const ready: Member = {
    definition: {
      enabled: true,
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    },
    readiness: { runtime: 'ready', auth: 'ready' },
  };
  const cases: [Member | undefined, string][] = [
    [undefined, '成员已不在列表中'],
    [{ ...ready, definition: { ...ready.definition, enabled: false } }, '已停用'],
    [{ ...ready, readiness: { runtime: 'error', auth: 'ready' } }, '连接失败'],
    [{ ...ready, readiness: { runtime: 'unknown', auth: 'ready' } }, '尚未确认连接'],
    [{ ...ready, readiness: { runtime: 'ready', auth: 'needs_login' } }, '需要登录'],
    [{ ...ready, readiness: { runtime: 'ready', auth: 'unknown' } }, '登录待确认'],
    [
      { ...ready, definition: { ...ready.definition, orchestration: { canBeBoss: false } } },
      '未启用负责人角色',
    ],
    [
      {
        ...ready,
        definition: { ...ready.definition, controlBridge: { transport: 'none', scopes: [] } },
      },
      '编排接口未接通',
    ],
  ];
  for (const [member, label] of cases) {
    expect(memberUnavailableReason(member, 'collaborative')?.label).toBe(label);
    if (member) expect(selectableAgents([member], 'collaborative')).toEqual([]);
  }
  expect(memberUnavailableReason(ready, 'collaborative')).toBeUndefined();
});

it('offers direct execution without promoting the agent or requiring unreported authentication', () => {
  const worker: Member = {
    definition: {
      enabled: true,
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    },
    readiness: { runtime: 'ready', auth: 'not_reported' },
  };
  const before = JSON.stringify(worker);
  expect(memberUnavailableReason(worker, 'direct')).toBeUndefined();
  expect(memberUnavailableReason(worker, 'collaborative')?.label).toBe('未启用负责人角色');
  expect(JSON.stringify(worker)).toBe(before);
});

it('offers the onboarding shortcut only after the current entry has finished successfully', () => {
  const ready: Member = {
    definition: {
      enabled: true,
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    },
    readiness: { runtime: 'ready', auth: 'ready' },
  };
  expect(usableOnboardingMember({ done: true, saved: ready })).toBe(ready);
  expect(usableOnboardingMember({ done: true, existing: ready })).toBe(ready);
  expect(usableOnboardingMember({ done: false, saved: ready })).toBeUndefined();
  expect(
    usableOnboardingMember({ done: true, error: 'entry failed', saved: ready }),
  ).toBeUndefined();
  expect(
    usableOnboardingMember({
      done: true,
      saved: { ...ready, readiness: { runtime: 'ready', auth: 'needs_login' } },
    }),
  ).toBeUndefined();
});
