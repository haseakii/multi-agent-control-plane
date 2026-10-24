import { z } from 'zod';
import { redactSensitiveText } from '@control-plane/core';
import { promptUsage } from '@control-plane/acp-runtime';

export const AgentProgressSchema = z.object({
  turnId: z.string().min(1),
  attemptId: z.string().min(1),
  agentId: z.string().min(1),
  text: z.string().max(4096),
  truncated: z.boolean(),
  state: z.enum(['streaming', 'complete', 'interrupted']),
  artifactId: z.string().optional(),
});

/** Bounded public message previews. Full text lives in artifacts, never in tool arguments. */
export class AgentProgressRecorder {
  private lastText = '';
  private lastAt = -Infinity;
  private toolCount = 0;
  private readonly tools = new Map<string, { title: string; status: string }>();
  constructor(
    private readonly identity: { turnId: string; attemptId: string; agentId: string },
    private readonly emit: (type: string, payload: Record<string, unknown>) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  text(
    output: string,
    state: 'streaming' | 'complete' | 'interrupted' = 'streaming',
    artifactId?: string,
    force = false,
  ) {
    const safe = redactSensitiveText(output).text;
    const preview = safe.slice(0, 4096);
    const at = this.clock();
    // A tool notification flushes new text, but must not replay the unchanged
    // transcript for every tool output chunk (including empty transcripts).
    if (state === 'streaming' && preview === this.lastText) return;
    if (
      state === 'streaming' &&
      !force &&
      (preview === this.lastText ||
        (at - this.lastAt < 750 && preview.length - this.lastText.length < 512))
    )
      return;
    this.lastText = preview;
    this.lastAt = at;
    this.emit(
      'agent.progress',
      AgentProgressSchema.parse({
        ...this.identity,
        text: preview,
        truncated: safe.length > 4096,
        state,
        ...(artifactId ? { artifactId } : {}),
      }),
    );
  }

  tool(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const item = payload as Record<string, unknown>;
    // Do not copy rawInput, tool results, opaque extensions or private reasoning.
    const toolCallId =
      typeof item.toolCallId === 'string'
        ? item.toolCallId.slice(0, 128)
        : `tool-${this.toolCount + 1}`;
    const previous = this.tools.get(toolCallId);
    const title =
      typeof item.title === 'string'
        ? item.title
        : typeof item.kind === 'string'
          ? item.kind
          : (previous?.title ?? 'Agent 工具');
    const status = ['pending', 'in_progress', 'completed', 'failed'].includes(String(item.status))
      ? String(item.status)
      : (previous?.status ?? 'in_progress');
    if (previous?.title === title && previous.status === status) return;
    if (++this.toolCount > 200) return;
    this.tools.set(toolCallId, { title, status });
    this.emit('agent.tool', {
      ...this.identity,
      toolCallId,
      title: redactSensitiveText(title).text.slice(0, 160),
      status,
    });
  }

  usage(value: unknown, source: 'acp-prompt' | 'acp-session') {
    if (source === 'acp-prompt') {
      const usage = promptUsage(value);
      if (usage) this.emit('agent.usage', { ...this.identity, source, ...usage });
    } else {
      const context = z
        .object({ used: z.number().nonnegative().finite(), size: z.number().positive().finite() })
        .safeParse(value);
      if (context.success)
        this.emit('agent.usage', {
          ...this.identity,
          source,
          contextUsed: context.data.used,
          contextSize: context.data.size,
        });
    }
  }
}
