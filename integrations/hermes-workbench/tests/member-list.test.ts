import { expect, it } from 'vitest';
import { filterMembers, memberStatus } from '../src/member-list';

const member = (id: string, auth = 'ready', enabled = true, runtime = 'ready') => ({
  definition: {
    id,
    name: `助手 ${id}`,
    description: '本地开发',
    enabled,
    capabilities: [{ name: 'code.review' }],
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  },
  readiness: { runtime, auth },
});

it('classifies members using task eligibility without treating a live connection as authenticated', () => {
  expect(memberStatus(member('one'))).toBe('ready');
  expect(memberStatus(member('one', 'not_reported'))).toBe('ready');
  expect(memberStatus(member('one', 'unknown'))).toBe('attention');
  expect(memberStatus(member('one', 'needs_login'))).toBe('attention');
  expect(memberStatus(member('one', 'ready', true, 'error'))).toBe('attention');
  expect(memberStatus(member('one', 'ready', false))).toBe('disabled');
});

it('combines text and status filters without mutating the registered members', () => {
  const members = [member('alpha'), member('beta', 'unknown'), member('gamma', 'ready', false)];
  const original = structuredClone(members);
  expect(filterMembers(members, '  ALPHA review  ', 'ready')).toEqual([members[0]]);
  expect(filterMembers(members, '本地', 'attention')).toEqual([members[1]]);
  expect(filterMembers(members, '', 'disabled')).toEqual([members[2]]);
  expect(filterMembers(members, 'missing', 'all')).toEqual([]);
  expect(filterMembers(members, '', 'all')).toEqual(members);
  expect(members).toEqual(original);
});

it('separates occupied members from idle ready members while preserving their connection status', () => {
  const members = [
    member('busy'),
    member('idle'),
    member('login', 'unknown'),
    member('disabled', 'ready', false),
  ];
  const before = structuredClone(members);
  const active = new Set(['busy', 'disabled']);
  expect(filterMembers(members, '', 'ready', active)).toEqual([members[1]]);
  expect(filterMembers(members, '', 'busy', active)).toEqual([members[0], members[3]]);
  expect(filterMembers(members, 'busy', 'busy', active)).toEqual([members[0]]);
  expect(filterMembers(members, '', 'attention', active)).toEqual([members[2]]);
  expect(filterMembers(members, '', 'disabled', active)).toEqual([]);
  expect(filterMembers(members, '', 'ready', new Set())).toEqual([members[0], members[1]]);
  expect(members).toEqual(before);
});
