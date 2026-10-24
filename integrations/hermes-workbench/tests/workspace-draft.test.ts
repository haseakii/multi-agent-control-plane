import { describe, expect, it } from 'vitest';
import { restoreWorkspaceDraft, workspaceDraftIntent } from '../src/workspace-draft';

describe('workspace draft intent', () => {
  it('restores the selected project beside an unsent draft', () => {
    const choice = { kind: 'saved-project', projectId: 'project-a' } as const;
    expect(restoreWorkspaceDraft(JSON.stringify(workspaceDraftIntent(choice)))).toEqual(choice);
  });
  it('preserves a local directory and mode without restoring validation authority', () => {
    const saved = workspaceDraftIntent({
      kind: 'existing-local',
      confirmedPath: 'D:\\projects\\demo',
      executionWorkspaceMode: 'git-worktree',
      validationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      expiresAt: '2026-10-25T00:00:00Z',
    });
    expect(restoreWorkspaceDraft(JSON.stringify(saved))).toEqual({
      kind: 'pending',
      path: 'D:\\projects\\demo',
      executionWorkspaceMode: 'git-worktree',
    });
    expect(JSON.stringify(saved)).not.toMatch(/validationId|expiresAt/);
  });
  it('preserves a partially entered directory', () => {
    const choice = {
      kind: 'pending',
      path: 'D:\\projects\\',
      executionWorkspaceMode: 'git-worktree',
    } as const;
    expect(restoreWorkspaceDraft(JSON.stringify(workspaceDraftIntent(choice)))).toEqual(choice);
  });
  it('does not silently choose an empty directory when saved intent is unreadable', () => {
    expect(restoreWorkspaceDraft('{')).toEqual({ kind: 'pending' });
    expect(restoreWorkspaceDraft(null)).toEqual({ kind: 'managed' });
  });
});
