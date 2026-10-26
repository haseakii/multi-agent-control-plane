import { expect, it } from 'vitest';
import { AgentProgressRecorder } from './agent-progress.js';

it('does not replay unchanged text or exhaust tool records on repeated output chunks', () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const recorder = new AgentProgressRecorder(
    { turnId: 't', attemptId: 'a', agentId: 'member' },
    (type, payload) => events.push({ type, payload }),
  );
  for (let n = 0; n < 250; n++) {
    recorder.text('', 'streaming', undefined, true);
    recorder.tool({ toolCallId: 'one', title: 'Read files', status: 'in_progress' });
  }
  expect(events).toHaveLength(1);
  recorder.text('Finished reading', 'streaming', undefined, true);
  recorder.text('Finished reading', 'streaming', undefined, true);
  recorder.tool({ toolCallId: 'one', status: 'completed' });
  recorder.text('Finished reading', 'complete', 'artifact');
  expect(events.map((event) => event.type)).toEqual([
    'agent.tool',
    'agent.progress',
    'agent.tool',
    'agent.progress',
  ]);
  expect(events.at(-1)?.payload).toMatchObject({ state: 'complete', artifactId: 'artifact' });
});

it('records bounded visible previews, tool status and the full transcript reference', () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let clock = 0;
  const recorder = new AgentProgressRecorder(
    { turnId: 'turn', attemptId: 'attempt', agentId: 'agent' },
    (type, payload) => events.push({ type, payload }),
    () => clock,
  );
  recorder.text('正在安排协作。');
  recorder.text('正在安排协作。稍后继续');
  expect(events).toHaveLength(1);
  recorder.text('正在安排协作。稍后继续', 'streaming', undefined, true);
  expect(events.at(-1)?.payload.text).toBe('正在安排协作。稍后继续');
  clock = 1000;
  recorder.text('x'.repeat(5000));
  recorder.tool({
    toolCallId: 'tool',
    title: '查看任务',
    status: 'in_progress',
    rawInput: { token: 'private' },
  });
  recorder.text('x'.repeat(5000), 'interrupted', 'artifact-log');
  expect(events[2]?.payload.text).toHaveLength(4096);
  expect(events.at(-1)?.payload).toMatchObject({
    state: 'interrupted',
    artifactId: 'artifact-log',
    truncated: true,
  });
  expect(JSON.stringify(events)).not.toContain('private');
  expect(events[3]?.payload).toMatchObject({ title: '查看任务', status: 'in_progress' });
  recorder.tool({ toolCallId: 'tool', status: 'completed' });
  expect(events.at(-1)?.payload).toMatchObject({ title: '查看任务', status: 'completed' });
});

it('redacts public previews and never copies tool inputs or opaque output', () => {
  const events: unknown[] = [];
  const recorder = new AgentProgressRecorder(
    { turnId: 't', attemptId: 'a', agentId: 'member' },
    (type, payload) => events.push({ type, payload }),
  );
  recorder.text('Authorization: Bearer private-token', 'complete');
  recorder.tool({
    title: 'Fetch https://example.test/?token=private-value',
    rawInput: { password: 'secret' },
    content: [{ text: 'hidden-output' }],
  });
  expect(JSON.stringify(events)).not.toMatch(/private-token|private-value|secret|hidden-output/);
});
