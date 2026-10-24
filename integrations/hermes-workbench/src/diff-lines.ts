export type DiffLine = {
  text: string;
  kind: 'file' | 'hunk' | 'add' | 'remove' | 'context';
  before?: number;
  after?: number;
};
export function diffLines(patch: string): DiffLine[] {
  let before: number | undefined, after: number | undefined;
  return patch.split('\n').map((text) => {
    if (text.startsWith('diff --git ')) {
      before = after = undefined;
      return { text, kind: 'file' };
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      return { text, kind: 'hunk' };
    }
    if (before !== undefined && after !== undefined) {
      if (text.startsWith('+')) return { text, kind: 'add', after: after++ };
      if (text.startsWith('-')) return { text, kind: 'remove', before: before++ };
      if (text.startsWith(' ')) return { text, kind: 'context', before: before++, after: after++ };
    }
    return { text, kind: text.startsWith('+++ ') || text.startsWith('--- ') ? 'file' : 'context' };
  });
}
