import { expect, it } from 'vitest';
import {
  onboardingDraftKey,
  readOnboardingDraft,
  reconcileOnboardingRows,
  writeOnboardingDraft,
  type OnboardingRow,
} from '../src/agent-onboarding-draft';
const row: OnboardingRow = {
  id: 'agent-00000000-0000-4000-8000-000000000001',
  name: 'Developer',
  selected: true,
  leader: false,
  runtime: {
    type: 'acp-stdio',
    command: 'C:/Tools/node.exe',
    args: ['C:/Tools/worker.js', '--stdio'],
  },
};
function store() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
it('restores editable rows with stable IDs, without cached readiness, auth or errors', () => {
  const storage = store();
  expect(
    writeOnboardingDraft(storage, [
      { ...row, done: true, saved: { token: 'never-store' }, error: 'old' } as OnboardingRow,
    ]),
  ).toBe('saved');
  expect(readOnboardingDraft(storage)).toEqual([row]);
  expect(storage.getItem(onboardingDraftKey)).not.toMatch(/done|token|saved|error/);
  expect(writeOnboardingDraft(storage, [])).toBe('empty');
  expect(readOnboardingDraft(storage)).toEqual([]);
});
it('retains an explicit catalog selection across reload without importing connection evidence', () => {
  const storage = store();
  const catalogRow = { ...row, catalogSelection: { entryId: 'example-agent', version: '1.2.3' } };
  expect(
    writeOnboardingDraft(storage, [
      {
        ...catalogRow,
        registrationSource: { status: 'linked' },
        definitionHash: 'old-hash',
      } as typeof catalogRow,
    ]),
  ).toBe('saved');
  expect(readOnboardingDraft(storage)).toEqual([catalogRow]);
  expect(storage.getItem(onboardingDraftKey)).not.toMatch(/registrationSource|definitionHash/);
  expect(readOnboardingDraft(storage)[0]?.id).toBe(row.id);
});
it('does not infer a catalog association for old custom drafts during reconciliation', () => {
  const storage = store();
  writeOnboardingDraft(storage, [row]);
  const restored = reconcileOnboardingRows(readOnboardingDraft(storage), []);
  expect(restored[0]).not.toHaveProperty('catalogSelection');
  expect(restored[0]?.runtime).toEqual(row.runtime);
});
it('reconciles lost registration responses and preserves the server role instead of cached status', () => {
  const agent = {
    definition: {
      id: row.id,
      name: 'Server name',
      runtime: row.runtime!,
      orchestration: { canBeBoss: true },
    },
    readiness: { runtime: 'ready' },
  };
  expect(reconcileOnboardingRows([row], [agent])[0]).toMatchObject({
    id: row.id,
    name: 'Server name',
    leader: true,
    saved: agent,
    done: true,
  });
  expect(
    reconcileOnboardingRows([row], [{ ...agent, readiness: { runtime: 'error' } }])[0]?.done,
  ).toBe(false);
  const revised = { ...row, runtime: { ...row.runtime!, args: ['C:/Tools/fixed.js'] } };
  expect(reconcileOnboardingRows([revised], [agent])[0]).toMatchObject({
    runtime: revised.runtime,
    done: false,
  });
  expect(reconcileOnboardingRows([row], [])[0]).toMatchObject({ done: false });
});
it('finds already-registered duplicate entries without treating them as a new registration', () => {
  const agent = {
    definition: {
      id: 'existing',
      name: 'Existing',
      runtime: row.runtime!,
      orchestration: { canBeBoss: false },
    },
    readiness: { runtime: 'error' },
  };
  const restored = reconcileOnboardingRows([row], [agent])[0];
  expect(restored).toMatchObject({ done: true, existing: agent });
  expect(restored).not.toHaveProperty('saved');
  expect(restored?.message).toContain('已存在');
  expect(restored?.message).not.toContain('连接正常');
  const storage = store();
  writeOnboardingDraft(storage, [restored!]);
  expect(storage.getItem(onboardingDraftKey)).not.toMatch(/existing|readiness|error/);
  const current = {
    ...agent,
    definition: { ...agent.definition, name: 'Renamed', enabled: false },
  };
  expect(reconcileOnboardingRows(readOnboardingDraft(storage), [current])[0]).toMatchObject({
    existing: current,
    done: true,
  });
});
it('does not retain credential-bearing arguments or stale drafts when saving is unavailable', () => {
  const storage = store();
  writeOnboardingDraft(storage, [row]);
  expect(
    writeOnboardingDraft(storage, [
      { ...row, runtime: { ...row.runtime!, args: ['--api-key=private-value'] } },
    ]),
  ).toBe('sensitive');
  expect(storage.getItem(onboardingDraftKey)).toBeNull();
  expect(
    writeOnboardingDraft(
      {
        ...storage,
        setItem: () => {
          throw Error('quota');
        },
      },
      [row],
    ),
  ).toBe('unavailable');
  expect(
    readOnboardingDraft({
      ...storage,
      getItem: () => {
        throw Error('blocked');
      },
    }),
  ).toEqual([]);
});
it('rejects unsupported or malformed cached layouts', () => {
  const storage = store();
  for (const value of [
    { version: 2, rows: [row] },
    { version: 1, rows: [row, row] },
    { version: 1, rows: [{ ...row, done: true }] },
  ]) {
    storage.setItem(onboardingDraftKey, JSON.stringify(value));
    expect(readOnboardingDraft(storage)).toEqual([]);
  }
});
