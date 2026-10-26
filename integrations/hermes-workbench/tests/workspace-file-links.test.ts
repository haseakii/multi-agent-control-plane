import { expect, it } from 'vitest';
import {
  resolveWorkspaceFile,
  workspaceFileHref,
  parseWorkspaceFileHref,
  rehypeWorkspaceFiles,
} from '../src/workspace-file-links';
import { patchForFile } from '../src/file-patch';
const scopes = [
  { taskId: 'task-a', rootPath: 'D:\\work\\a' },
  { taskId: 'task-b', rootPath: 'D:/work/b' },
];
it('maps file URLs and Windows file references to their actual task scope', () => {
  expect(resolveWorkspaceFile('file:///D:/work/a/js/app.js', scopes)).toEqual({
    taskId: 'task-a',
    path: 'js/app.js',
  });
  expect(resolveWorkspaceFile('D:\\work\\b\\index.html:12', scopes)).toEqual({
    taskId: 'task-b',
    path: 'index.html',
  });
  expect(resolveWorkspaceFile('file:///D:/work/a/%E4%B8%AD%E6%96%87.md#L2', scopes)?.path).toBe(
    '中文.md',
  );
});
it('does not turn outside, ambiguous, traversing or executable links into file access', () => {
  for (const value of [
    'file:///D:/private/key',
    'D:/work/a-other/key',
    'D:/work/a/../b/key',
    'file://remote/share/a',
    'javascript:alert(1)',
    'https://example.com/a',
    'index.html',
  ])
    expect(resolveWorkspaceFile(value, scopes)).toBeUndefined();
  expect(
    resolveWorkspaceFile('D:/work/a/a.ts', [...scopes, { taskId: 'other', rootPath: 'D:/work/a' }]),
  ).toBeUndefined();
  expect(
    parseWorkspaceFileHref(workspaceFileHref({ taskId: 'outside', path: 'a.ts' }), ['task-a']),
  ).toBeUndefined();
  expect(
    parseWorkspaceFileHref(workspaceFileHref({ taskId: 'task-a', path: '../key' }), ['task-a']),
  ).toBeUndefined();
});
it('rewrites only matching anchor nodes before sanitation', () => {
  const tree = {
    children: [
      { type: 'element', tagName: 'a', properties: { href: 'file:///D:/work/a/a.ts' } },
      { type: 'element', tagName: 'img', properties: { src: 'file:///D:/work/a/a.ts' } },
    ],
  };
  rehypeWorkspaceFiles(scopes)(tree);
  expect(parseWorkspaceFileHref(tree.children[0]!.properties.href!, ['task-a'])).toEqual({
    taskId: 'task-a',
    path: 'a.ts',
  });
  expect(tree.children[1]!.properties.src).toBe('file:///D:/work/a/a.ts');
});
it('selects file diffs including deleted and Git-quoted UTF-8 names without mixing other files', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ /dev/null\n-gone\ndiff --git a/x b/x\n--- /dev/null\n+++ "b/\\344\\270\\255.md"\n+中文\n';
  expect(patchForFile(patch, 'a.ts')).toContain('+new');
  expect(patchForFile(patch, 'a.ts')).not.toContain('gone');
  expect(patchForFile(patch, 'b.ts')).toContain('-gone');
  expect(patchForFile(patch, '中.md')).toContain('+中文');
  expect(patchForFile(patch, 'missing')).toBeUndefined();
});
