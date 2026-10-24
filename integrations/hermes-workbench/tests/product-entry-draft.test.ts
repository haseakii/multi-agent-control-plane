import { expect, it } from 'vitest';
import {
  clearProductEntryDraft,
  readProductEntryDraft,
  writeProductEntryDraft,
} from '../src/product-entry-draft';

function store() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const fields = {
  directory: 'C:/My Tools/adapter',
  command: 'C:/Tools/node.exe',
  script: 'C:/My Tools/adapter/index.js',
  args: ['--stdio', '', 'value with spaces'],
  nodeMode: true,
};

it('keeps incomplete product inputs separately with exact argument boundaries across reopen', () => {
  const storage = store();
  expect(writeProductEntryDraft(storage, 'product-a', fields)).toBe('saved');
  const other = { ...fields, command: 'D:/Tools/other.exe', script: '', nodeMode: false };
  expect(writeProductEntryDraft(storage, 'product-b', other)).toBe('saved');
  expect(readProductEntryDraft(storage, 'product-a')).toEqual(fields);
  expect(readProductEntryDraft(storage, 'product-b')).toEqual(other);
  clearProductEntryDraft(storage, 'product-a');
  expect(readProductEntryDraft(storage, 'product-a')).toBeUndefined();
  expect(readProductEntryDraft(storage, 'product-b')).toEqual(other);
  expect([...storage.values.values()].join()).not.toMatch(/readiness|authMethods|permissions/);
});

it('does not retain inputs containing credentials or an older copy of those fields', () => {
  const storage = store();
  writeProductEntryDraft(storage, 'product-a', fields);
  expect(
    writeProductEntryDraft(storage, 'product-a', { ...fields, args: ['--api-key=private-value'] }),
  ).toBe('sensitive');
  expect(storage.values.size).toBe(0);
  expect(readProductEntryDraft(storage, 'product-a')).toBeUndefined();
});

it('validates stored identity and shape and degrades gracefully without browser storage', () => {
  const storage = store();
  writeProductEntryDraft(storage, 'product-a', fields);
  const key = [...storage.values.keys()][0]!;
  storage.values.set(key, JSON.stringify({ version: 1, productId: 'product-b', fields }));
  expect(readProductEntryDraft(storage, 'product-a')).toBeUndefined();
  storage.values.set(
    key,
    JSON.stringify({ version: 1, productId: 'product-a', fields: { ...fields, auth: 'ready' } }),
  );
  expect(readProductEntryDraft(storage, 'product-a')).toBeUndefined();
  expect(
    writeProductEntryDraft(
      {
        ...storage,
        setItem: () => {
          throw Error('Storage unavailable');
        },
      },
      'product-a',
      fields,
    ),
  ).toBe('unavailable');
  expect(storage.values.size).toBe(0);
});
