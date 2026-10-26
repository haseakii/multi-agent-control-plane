export type InstructionView = {
  id: string;
  content: string;
  state: 'queued' | 'claimed' | 'delivered';
};
export type InstructionSnapshot = {
  instructions: InstructionView[];
  canSubmit: boolean;
  reason: 'active' | 'task_ended' | 'not_executing' | 'finishing' | 'stopping' | 'owner_changed';
};

/** A component instance belongs to exactly one project/task, enforced by its React key. */
export class InstructionSubmission {
  private request: { content: string; idempotencyKey: string } | undefined;
  private busy = false;
  constructor(private readonly key: () => string) {}
  begin(content: string) {
    if (this.busy || !content.trim() || content.length > 4000) return undefined;
    if (this.request && this.request.content !== content.trim()) return undefined;
    this.request ??= { content: content.trim(), idempotencyKey: this.key() };
    this.busy = true;
    return { ...this.request };
  }
  finish(outcome: 'confirmed' | 'rejected' | 'unknown') {
    this.busy = false;
    if (outcome !== 'unknown') this.request = undefined;
  }
}
