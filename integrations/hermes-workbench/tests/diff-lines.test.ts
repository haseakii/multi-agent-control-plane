import { expect, it } from 'vitest';
import { diffLines } from '../src/diff-lines';
it('keeps separate original and new line numbers across hunks and files', () => {
  const rows = diffLines(
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,2 +7,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n@@ -20 +25 @@\n+++ literal\ndiff --git a/b b/b\n--- a/b\n+++ b/b',
  );
  expect(rows[4]).toEqual({ text: ' same', kind: 'context', before: 3, after: 7 });
  expect(rows[5]).toEqual({ text: '-old', kind: 'remove', before: 4 });
  expect(rows[6]).toEqual({ text: '+new', kind: 'add', after: 8 });
  expect(rows[7]?.after).toBeUndefined();
  expect(rows[9]).toEqual({ text: '+++ literal', kind: 'add', after: 25 });
  expect(rows[12]).toEqual({ text: '+++ b/b', kind: 'file' });
});
