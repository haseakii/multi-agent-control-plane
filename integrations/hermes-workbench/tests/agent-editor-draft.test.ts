import { expect, it } from 'vitest';
import {
  agentEditorFields,
  clearAgentEditorDraft,
  readAgentEditorDraft,
  writeAgentEditorDraft,
  reconcileEditorDraft,
} from '../src/agent-editor-draft';
function store() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
const base = {
  ...agentEditorFields(),
  id: 'worker-a',
  name: 'Worker A',
  command: 'C:/Tools/node.exe',
  args: ['C:/Tools/worker.js'],
  environment: 'PATH\nOPENAI_API_KEY',
};
it('keeps separate member drafts without applying or caching server state', () => {
  const storage = store();
  const draft = { ...base, name: 'Reviewer', args: ['C:/My Tools/reviewer.js', ''] };
  expect(writeAgentEditorDraft(storage, base.id, base, draft)).toBe('saved');
  expect(readAgentEditorDraft(storage, base.id, base)).toEqual({
    fields: draft,
    changed: false,
    conflicts: [],
  });
  expect(readAgentEditorDraft(storage, 'worker-b', { ...base, id: 'worker-b' })).toBeUndefined();
  expect([...storage.data.values()].join()).not.toMatch(
    /readiness|authMethods|permissions|secretRef/,
  );
});
it('retains unrelated server edits and identifies fields edited on both sides before restoration', () => {
  const edits = { ...base, name: 'My title', capabilities: 'review' };
  const latest = {
    ...base,
    name: 'Other title',
    command: 'C:/New/agent.exe',
    scopes: ['artifact.read' as const],
  };
  const merged = reconcileEditorDraft(base, edits, latest);
  expect(merged.conflicts).toEqual(['name']);
  expect(merged.fields).toMatchObject({
    name: 'My title',
    capabilities: 'review',
    command: latest.command,
    scopes: latest.scopes,
  });
  expect(latest.name).toBe('Other title');
  expect(edits.command).toBe(base.command);
});
it('detects a changed server definition before restoring stale edits', () => {
  const storage = store();
  writeAgentEditorDraft(storage, base.id, base, { ...base, name: 'Draft' });
  expect(
    readAgentEditorDraft(storage, base.id, { ...base, command: 'C:/Updated/agent.exe' }),
  ).toMatchObject({ changed: true, fields: { name: 'Draft' } });
});
it('removes superseded drafts when sensitive parameters appear', () => {
  const storage = store();
  writeAgentEditorDraft(storage, base.id, base, { ...base, name: 'Draft' });
  expect(
    writeAgentEditorDraft(storage, base.id, base, { ...base, args: ['--token=private-value'] }),
  ).toBe('sensitive');
  expect(storage.data.size).toBe(0);
});
it('clears discarded or saved drafts without touching other members', () => {
  const storage = store();
  writeAgentEditorDraft(storage, base.id, base, { ...base, name: 'Draft' });
  const second = { ...base, id: 'worker-b' };
  writeAgentEditorDraft(storage, second.id, second, { ...second, name: 'Other draft' });
  clearAgentEditorDraft(storage, base.id);
  expect(readAgentEditorDraft(storage, base.id, base)).toBeUndefined();
  expect(readAgentEditorDraft(storage, second.id, second)?.fields.name).toBe('Other draft');
});
it('keeps new manual registration identity across editor remounts', () => {
  const storage = store();
  const initial = agentEditorFields();
  writeAgentEditorDraft(storage, undefined, initial, { ...initial, name: 'New worker' });
  expect(readAgentEditorDraft(storage, undefined, agentEditorFields())).toMatchObject({
    changed: false,
    fields: { id: initial.id, name: 'New worker' },
  });
});
it('does not let storage failures break editing or keep stale cache', () => {
  const storage = store();
  writeAgentEditorDraft(storage, base.id, base, { ...base, name: 'Old draft' });
  expect(
    writeAgentEditorDraft(
      {
        ...storage,
        setItem: () => {
          throw Error('quota');
        },
      },
      base.id,
      base,
      { ...base, name: 'Latest draft' },
    ),
  ).toBe('unavailable');
  expect(storage.data.size).toBe(0);
});
