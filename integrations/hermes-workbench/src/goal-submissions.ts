import { z } from 'zod';
import { composerDrafts, type createComposerDrafts } from './composer-drafts';
import { workspaceDraftIntent } from './workspace-draft';
import type { WorkspaceSelection } from './workspace-api';
import type { DraftSubmission } from './draft-submission';
const Saved = z
  .object({
    workspace: z.string().max(16384),
    submission: z
      .object({
        projectId: z.string().min(1).max(128),
        taskId: z.string().min(1).max(128).optional(),
        createKey: z.string().uuid().optional(),
        creationObjective: z.string().min(1).max(100000).optional(),
      })
      .strict(),
  })
  .strict();
export function createGoalSubmissions(drafts: ReturnType<typeof createComposerDrafts>) {
  const key = (scope: string) => `hermes-goal-submission-${scope}`;
  const signature = (choice: WorkspaceSelection) => JSON.stringify(workspaceDraftIntent(choice));
  return {
    read(scope: string, choice: WorkspaceSelection): DraftSubmission | undefined {
      try {
        const text = drafts.read(key(scope)).text;
        if (!text) return undefined;
        const saved = Saved.parse(JSON.parse(text));
        return saved.workspace === signature(choice) ? saved.submission : undefined;
      } catch {
        return undefined;
      }
    },
    write(scope: string, choice: WorkspaceSelection, submission: DraftSubmission) {
      const saved = Saved.parse({ workspace: signature(choice), submission });
      return drafts.write(key(scope), JSON.stringify(saved));
    },
    clear(scope: string) {
      drafts.clear(key(scope));
    },
  };
}
export const goalSubmissions = createGoalSubmissions(composerDrafts);
