import { expect, it } from 'vitest';
import {
  filterConversations,
  scopeConversations,
  conversationProjects,
  needsAttention,
  type SearchableConversation,
} from '../src/conversation-search';
const item = (id: string, extra: Partial<SearchableConversation> = {}): SearchableConversation => ({
  id,
  title: id,
  state: 'completed',
  searchText: '',
  pendingReview: false,
  pendingApproval: false,
  ...extra,
});

it('keeps completed work with pending review discoverable without calling it failed', () => {
  const rows = [
    item('review', { pendingReview: true }),
    item('recovered'),
    item('failed', { state: 'failed' }),
    item('permission', { state: 'running', pendingApproval: true }),
  ];
  expect(filterConversations(rows, '', 'attention').map((row) => row.id)).toEqual([
    'review',
    'failed',
    'permission',
  ]);
  expect(filterConversations(rows, '', 'completed').map((row) => row.id)).toEqual([
    'review',
    'recovered',
  ]);
  expect(rows[0]!.state).toBe('completed');
});

it('searches combined conversation context with case-insensitive words while keeping recent order', () => {
  const rows = [
    item('new', { title: '页面修改', searchText: 'Northstar\nAntigravity\n追问修改颜色' }),
    item('old', { title: '另一个页面', searchText: 'Codex' }),
  ];
  expect(filterConversations(rows, ' NORTHSTAR  追问 ', 'all')).toEqual([rows[0]]);
  expect(filterConversations(rows, '页面', 'all')).toEqual(rows);
  expect(filterConversations(rows, 'Codex', 'attention')).toEqual([]);
  expect(filterConversations(rows, '', 'all')[0]).toBe(rows[0]);
});

it('separates unfinished drafts and stopped tasks from running work', () => {
  const rows = [
    item('draft', { state: 'draft' }),
    item('stopped', { state: 'cancelled' }),
    item('waiting', { state: 'waiting' }),
    item('running', { state: 'running' }),
  ];
  expect(filterConversations(rows, '', 'draft').map((row) => row.id)).toEqual(['draft']);
  expect(filterConversations(rows, '', 'cancelled').map((row) => row.id)).toEqual(['stopped']);
  expect(filterConversations(rows, '', 'active').map((row) => row.id)).toEqual([
    'waiting',
    'running',
  ]);
});

it('keeps project scope exact and applies status and words within it without changing the records', () => {
  const rows = [
    item('other', { projectId: 'b', state: 'failed', searchText: '页面' }),
    item('review', { projectId: 'a', pendingReview: true, searchText: '页面' }),
    item('retry', { projectId: 'a', state: 'blocked', searchText: '页面' }),
    item('done', { projectId: 'a', searchText: '页面' }),
  ];
  const before = structuredClone(rows);
  const scoped = scopeConversations(rows, 'a');
  expect(scoped.filter(needsAttention).length).toBe(2);
  expect(filterConversations(scoped, '页面', 'failed')).toEqual([rows[2]]);
  expect(filterConversations(scoped, '页面', 'attention')).toEqual([rows[1], rows[2]]);
  expect(scopeConversations(rows, 'missing')).toEqual([]);
  expect(scopeConversations(rows, '')).toBe(rows);
  expect(rows).toEqual(before);
});

it('counts conversations per project and distinguishes same-named or unavailable projects', () => {
  const rows = [
    item('latest', { projectId: 'b' }),
    item('earlier', { projectId: 'a' }),
    item('old', { projectId: 'b' }),
    item('orphan', { projectId: 'removed' }),
  ];
  expect(
    conversationProjects(rows, [
      { id: 'a', name: '页面开发' },
      { id: 'b', name: '页面开发' },
      { id: 'empty', name: '空项目' },
    ]),
  ).toEqual([
    { id: 'b', name: '页面开发 · b', count: 2 },
    { id: 'a', name: '页面开发 · a', count: 1 },
    { id: 'removed', name: '项目 removed', count: 1 },
  ]);
});
