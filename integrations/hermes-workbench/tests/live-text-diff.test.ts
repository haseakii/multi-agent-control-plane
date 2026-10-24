import { expect, it } from 'vitest';
import { compareLiveText } from '../src/live-text-diff';

const lines = (value: string) => value.replaceAll('\r\n', '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
function assertReconstructs(before: string, after: string) {
  const result = compareLiveText(before, after);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw Error('Expected computed diff');
  const changed = result.groups.flat().filter((line) => line.kind !== 'context');
  const deleted = new Set(
    changed.filter((line) => line.kind === 'remove').map((line) => line.before),
  );
  const reconstructed = lines(before).filter((_, index) => !deleted.has(index + 1));
  for (const line of changed) {
    const value = line.text.slice(1) + (line.noNewline ? '' : '\n');
    if (line.kind === 'remove') expect(value).toBe(lines(before)[line.before! - 1]);
    if (line.kind === 'add') reconstructed.splice(line.after! - 1, 0, value);
  }
  expect(reconstructed.join('')).toBe(after.replaceAll('\r\n', '\n'));
  return result;
}

it('locates separate edits in a long file with exact line numbers and bounded context', () => {
  const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}\n`);
  const after = [...before];
  after[10] = 'first change\n';
  after[900] = 'second change\n';
  const result = assertReconstructs(before.join(''), after.join(''));
  expect(result.groups).toHaveLength(2);
  expect(result.additions).toBe(2);
  expect(result.deletions).toBe(2);
  expect(result.groups[0]?.find((line) => line.kind === 'add')).toMatchObject({
    after: 11,
    text: '+first change',
  });
  expect(result.groups[1]?.find((line) => line.kind === 'remove')).toMatchObject({
    before: 901,
    text: '-line 901',
  });
  expect(result.groups.every((group) => group.length === 8)).toBe(true);
});

it('preserves insertions, deletions, blank lines and EOF newline changes while ignoring CRLF checkout conversion', () => {
  for (const [before, after] of [
    ['', 'new\n'],
    ['old\n', ''],
    ['a\n', 'a'],
    ['a', 'a\n'],
    ['\n', ''],
    ['a\n\nb\n', 'a\nextra\n\nb\n'],
    ['a\r\nb\r\n', 'a\nb\n'],
    ['x\nx\ny\nx\n', 'x\ny\nx\nx\n'],
  ])
    assertReconstructs(before!, after!);
  expect(compareLiveText('same\r\n', 'same\n')).toEqual({
    kind: 'ready',
    groups: [],
    additions: 0,
    deletions: 0,
  });
  const eof = assertReconstructs('a\n', 'a');
  expect(eof.groups.flat().find((line) => line.kind === 'add')?.noNewline).toBe(true);
});

it('reconstructs deterministic combinations of repeated and reordered lines', () => {
  let seed = 47;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 150; i++) {
    const text = () => Array.from({ length: next() % 25 }, () => `${next() % 7}\n`).join('');
    assertReconstructs(text(), text());
  }
});

it('returns an explicit full-content fallback when calculation or rendering would be too large', () => {
  expect(compareLiveText('old\n'.repeat(300), 'new\n'.repeat(300))).toEqual({ kind: 'limited' });
  expect(compareLiveText('', 'new\n'.repeat(2100))).toEqual({ kind: 'limited' });
  expect(compareLiveText('same\n'.repeat(11_000), 'same\n'.repeat(11_000))).toEqual({
    kind: 'limited',
  });
});
