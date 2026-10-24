import { z } from 'zod';
import type { WorkspaceSelection } from './workspace-api';
import { composerDrafts } from './composer-drafts';

const key = 'control-plane-workspace-draft';
const Intent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed') }).strict(),
  z.object({ kind: z.literal('saved-project'), projectId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal('pending'),
      path: z.string().max(4096).optional(),
      executionWorkspaceMode: z.enum(['git-worktree', 'shared-directory']).optional(),
    })
    .strict(),
]);

/** Persist user intent only. Directory validation and execution approval never survive reload. */
export function workspaceDraftIntent(value: WorkspaceSelection): WorkspaceSelection {
  if (value.kind === 'existing-local')
    return {
      kind: 'pending',
      path: value.confirmedPath,
      executionWorkspaceMode: value.executionWorkspaceMode,
    };
  return Intent.parse(value);
}

export function restoreWorkspaceDraft(raw: string | null): WorkspaceSelection {
  if (raw === null) return { kind: 'managed' };
  try {
    return Intent.parse(JSON.parse(raw));
  } catch {
    return { kind: 'pending' };
  }
}

export const readWorkspaceDraft = () => restoreWorkspaceDraft(composerDrafts.read(key).text);
export const saveWorkspaceDraft = (value: WorkspaceSelection) =>
  composerDrafts.write(key, JSON.stringify(workspaceDraftIntent(value)));
