import type { ProjectWorkspace, WorkspaceSelection } from './workspace-api';

/** A remembered project ID is not permission to silently switch the selected directory. */
export function matchesCreatedWorkspace(workspace: ProjectWorkspace, choice: WorkspaceSelection) {
  if (choice.kind === 'managed') return workspace.mode === 'task-local' && !workspace.confirmation;
  if (choice.kind === 'saved-project') return workspace.project.id === choice.projectId;
  const path = choice.kind === 'existing-local' ? choice.confirmedPath : choice.path;
  return (
    !!path &&
    workspace.rootPath === path &&
    workspace.mode === (choice.executionWorkspaceMode ?? 'git-worktree')
  );
}
