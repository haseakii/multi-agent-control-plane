import type { DiffLine } from './diff-lines';

export type LiveDiffLine = DiffLine & { noNewline?: boolean };
export type LiveDiff =
  | { kind: 'ready'; groups: LiveDiffLine[][]; additions: number; deletions: number }
  | { kind: 'limited' };
type Edit = { kind: 'context' | 'add' | 'remove'; value: string };
const tokens = (value: string) => value.replaceAll('\r\n', '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Bounded Myers line comparison. Failure to compute is explicit, never an empty/clean diff. */
function edits(a: string[], b: string[]): Edit[] | undefined {
  if (!a.length) return b.map((value) => ({ kind: 'add', value }));
  if (!b.length) return a.map((value) => ({ kind: 'remove', value }));
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;
  for (let depth = 0; depth <= Math.min(a.length + b.length, 256); depth++) {
    trace.push(new Map(frontier));
    for (let k = -depth; k <= depth; k += 2) {
      if (++work > 1_000_000) return undefined;
      let x =
        k === -depth || (k !== depth && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
          ? (frontier.get(k + 1) ?? 0)
          : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        if (++work > 1_000_000) return undefined;
        x++;
        y++;
      }
      frontier.set(k, x);
      if (x < a.length || y < b.length) continue;
      const result: Edit[] = [];
      for (let d = trace.length - 1; d >= 0; d--) {
        const previous = trace[d]!,
          diagonal = x - y;
        const previousDiagonal =
          diagonal === -d ||
          (diagonal !== d &&
            (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
            ? diagonal + 1
            : diagonal - 1;
        const previousX = previous.get(previousDiagonal) ?? 0,
          previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) {
          result.push({ kind: 'context', value: a[--x]! });
          y--;
        }
        if (!d) break;
        if (x === previousX) result.push({ kind: 'add', value: b[--y]! });
        else result.push({ kind: 'remove', value: a[--x]! });
      }
      return result.reverse();
    }
  }
  return undefined;
}

export function compareLiveText(before: string, after: string): LiveDiff {
  const a = tokens(before),
    b = tokens(after);
  if (a.length + b.length > 20_000) return { kind: 'limited' };
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const middle = edits(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  if (!middle) return { kind: 'limited' };
  const all: Edit[] = [
    ...a.slice(0, prefix).map((value) => ({ kind: 'context' as const, value })),
    ...middle,
    ...a.slice(a.length - suffix).map((value) => ({ kind: 'context' as const, value })),
  ];
  let oldLine = 1,
    newLine = 1,
    additions = 0,
    deletions = 0;
  const lines: LiveDiffLine[] = all.map((edit) => {
    const line: LiveDiffLine = {
      kind: edit.kind,
      text: `${edit.kind === 'add' ? '+' : edit.kind === 'remove' ? '-' : ' '}${edit.value.replace(/\n$/, '')}`,
      noNewline: !edit.value.endsWith('\n'),
    };
    if (edit.kind !== 'add') line.before = oldLine++;
    if (edit.kind !== 'remove') line.after = newLine++;
    if (edit.kind === 'add') additions++;
    if (edit.kind === 'remove') deletions++;
    return line;
  });
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === 'context') continue;
    const start = Math.max(0, i - 3),
      end = Math.min(lines.length, i + 4),
      previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  if (ranges.some((range) => range.end - range.start > 2000)) return { kind: 'limited' };
  return {
    kind: 'ready',
    groups: ranges.map((range) => lines.slice(range.start, range.end)),
    additions,
    deletions,
  };
}
