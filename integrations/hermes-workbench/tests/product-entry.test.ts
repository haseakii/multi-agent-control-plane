import { expect, it } from 'vitest';
import { appendAgentCandidates, parseAgentCommand } from '../src/agent-quick-config';

it('keeps repeated invalid imports from consuming the remaining batch capacity', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `original-${index}`,
    name: `member-${index}`,
    error: 'Invalid local path',
    selected: false,
  }));
  const repeated = rows.map((row) => ({ ...row, id: `repeated-${row.id}` }));
  const result = appendAgentCandidates(rows, repeated);
  expect(result).toEqual(rows);
  expect(result.every((row, index) => row === rows[index])).toBe(true);
});

it('retains distinct diagnostics and accepts a corrected entry with the same name', () => {
  const original = { name: 'member', error: 'Invalid local path' };
  const changedError = { name: 'member', error: 'Unexpected environment values' };
  const otherMember = { name: 'other', error: original.error };
  const repaired = { name: 'member', runtime: parseAgentCommand('C:/Tools/agent.exe').runtime };
  expect(appendAgentCandidates([original], [changedError, otherMember, repaired])).toEqual([
    original,
    changedError,
    otherMember,
    repaired,
  ]);
});
import { prepareProductEntry } from '../src/product-entry';

const runtime = (command: string, args: string[] = []) =>
  parseAgentCommand(JSON.stringify({ command, args })).runtime;
it('adds product arguments after an installed script without replacing explicit parameters', () => {
  const node = runtime('C:/Tools/node.exe', ['C:/Tools/adapter/index.js']);
  expect(prepareProductEntry(node, ['--acp']).args).toEqual(['C:/Tools/adapter/index.js', '--acp']);
  expect(prepareProductEntry({ ...node, args: [...node.args, '--stdio'] }, ['--acp']).args).toEqual(
    [...node.args, '--stdio'],
  );
  expect(prepareProductEntry(runtime('C:/Tools/worker.exe'), ['--stdio']).args).toEqual([
    '--stdio',
  ]);
});
it('keeps names, IDs, selection and successful progress when adding multiple products or duplicates', () => {
  const first = {
    id: 'first',
    name: 'My worker',
    selected: false,
    done: true,
    runtime: runtime('C:/Tools/one.exe'),
  };
  const second = {
    id: 'second',
    name: 'Other',
    selected: true,
    done: false,
    runtime: runtime('C:/Tools/two.exe'),
  };
  const result = appendAgentCandidates([first], [{ ...first, id: 'duplicate' }, second]);
  expect(result).toEqual([first, second]);
  expect(result[0]).toBe(first);
  expect(appendAgentCandidates(result, [second])).toEqual(result);
});
it('bounds the whole staged batch, without changing existing rows on error', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    runtime: runtime(`C:/Tools/worker-${i}.exe`),
  }));
  expect(() =>
    appendAgentCandidates(rows, [{ id: 'extra', runtime: runtime('C:/Tools/extra.exe') }]),
  ).toThrow('20');
  expect(rows).toHaveLength(20);
});
