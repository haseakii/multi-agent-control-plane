/** These controls are siblings. The first round shares a task/conversation id,
 * while later rounds change the runtime card without remounting the input.
 */
export function conversationControlKeys(taskId: string, conversationId: string) {
  return {
    runtimeSettings: `runtime-settings:${taskId}`,
    followUpComposer: `followup-composer:${conversationId}`,
  };
}
