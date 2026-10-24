import { expect, it } from 'vitest';
import { createComposerDrafts } from '../src/composer-drafts';
import { createGoalSubmissions } from '../src/goal-submissions';
import { matchesCreatedWorkspace } from '../src/workspace-project-recovery';
function fixture() {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  return () => createGoalSubmissions(createComposerDrafts(() => store));
}
it('restores project and draft identities across reload and clears after confirmation', () => {
  const reload = fixture(),
    choice = { kind: 'managed' } as const;
  const submission = {
    projectId: 'project-a',
    taskId: 'task-a',
    createKey: '00000000-0000-4000-8000-000000000001',
    creationObjective: 'Original goal',
  };
  reload().write('new', choice, submission);
  expect(reload().read('new', choice)).toEqual(submission);
  reload().clear('new');
  expect(reload().read('new', choice)).toBeUndefined();
});
it('does not reuse a pending project after the user selects a different workspace', () => {
  const reload = fixture();
  reload().write('new', { kind: 'saved-project', projectId: 'a' }, { projectId: 'a' });
  expect(reload().read('new', { kind: 'saved-project', projectId: 'b' })).toBeUndefined();
  expect(reload().read('other', { kind: 'saved-project', projectId: 'a' })).toBeUndefined();
});
it('restores a validated local directory as intent without retaining its permission token', () => {
  const reload = fixture();
  reload().write(
    'new',
    {
      kind: 'existing-local',
      confirmedPath: 'D:/projects/demo',
      executionWorkspaceMode: 'git-worktree',
      validationId: '00000000-0000-4000-8000-000000000001',
      expiresAt: '2026-10-24T00:00:00Z',
    },
    { projectId: 'a' },
  );
  expect(
    reload().read('new', {
      kind: 'pending',
      path: 'D:/projects/demo',
      executionWorkspaceMode: 'git-worktree',
    }),
  ).toEqual({ projectId: 'a' });
});
it('checks the recovered project directory and execution mode before reuse', () => {
  const workspace = {
    project: { id: 'a', name: 'A' },
    rootPath: 'D:/projects/demo',
    mode: 'git-worktree' as const,
    confirmation: { workspaceId: 'w', rootPath: 'D:/projects/demo', version: 'current' },
  };
  expect(
    matchesCreatedWorkspace(workspace, {
      kind: 'pending',
      path: 'D:/projects/demo',
      executionWorkspaceMode: 'git-worktree',
    }),
  ).toBe(true);
  expect(
    matchesCreatedWorkspace(workspace, {
      kind: 'pending',
      path: 'D:/elsewhere',
      executionWorkspaceMode: 'git-worktree',
    }),
  ).toBe(false);
  expect(matchesCreatedWorkspace(workspace, { kind: 'managed' })).toBe(false);
  expect(
    matchesCreatedWorkspace(
      { ...workspace, mode: 'shared-directory' },
      { kind: 'pending', path: 'D:/projects/demo', executionWorkspaceMode: 'git-worktree' },
    ),
  ).toBe(false);
});
