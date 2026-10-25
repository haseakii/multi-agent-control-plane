import { z } from 'zod';
import { composerDrafts, type createComposerDrafts } from './composer-drafts';
import {
  SessionSettingValues,
  sameSessionValues,
  type SessionSettingValuesData,
} from './session-setting-values';

const Pending = z
  .object({
    taskId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(8000),
    key: z.string().uuid(),
    sessionSettings: SessionSettingValues.optional(),
  })
  .strict();
export function createFollowUpSubmissions(
  drafts: ReturnType<typeof createComposerDrafts>,
  newKey: () => string,
) {
  const storageKey = (conversationId: string) => `hermes-pending-send-${conversationId}`;
  const read = (conversationId: string) => {
    try {
      const raw = drafts.read(storageKey(conversationId)).text;
      return raw ? Pending.parse(JSON.parse(raw)) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    read,
    prepare(
      conversationId: string,
      taskIds: string[],
      latestTaskId: string,
      text: string,
      sessionSettings?: SessionSettingValuesData,
    ) {
      const previous = read(conversationId);
      const reused =
        !!previous &&
        previous.text === text.trim() &&
        taskIds.includes(previous.taskId) &&
        sameSessionValues(previous.sessionSettings, sessionSettings);
      const request = reused
        ? previous
        : Pending.parse({
            taskId: latestTaskId,
            text: text.trim(),
            key: newKey(),
            ...(sessionSettings === undefined ? {} : { sessionSettings }),
          });
      const stored = drafts.write(storageKey(conversationId), JSON.stringify(request));
      return { request, reused, persisted: stored.persisted };
    },
    clear(conversationId: string) {
      drafts.clear(storageKey(conversationId));
    },
  };
}
export const followUpSubmissions = createFollowUpSubmissions(composerDrafts, () =>
  crypto.randomUUID(),
);
