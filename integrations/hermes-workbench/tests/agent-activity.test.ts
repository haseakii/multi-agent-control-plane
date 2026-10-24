import { expect, it } from 'vitest';
import { agentActivity } from '../src/agent-activity';

it('reconciles live/replayed snapshots by attempt and turn without mixing tasks or retries', () => {
  const event = (id: string, attemptId: string, text: string, taskId = 'task') => ({
    id,
    taskId,
    type: 'agent.progress',
    occurredAt: `2026-10-23T06:00:0${id.length}Z`,
    payload: {
      turnId: 'turn',
      attemptId,
      agentId: 'member',
      text,
      truncated: false,
      state: 'streaming',
    },
  });
  const entries = agentActivity(
    [
      event('a', 'first', '初稿'),
      event('bb', 'first', '完整回复'),
      event('ccc', 'second', '重试回复'),
      event('dddd', 'other', '不应显示', 'other'),
    ],
    ['task'],
  );
  expect(entries.map((e) => e.text)).toEqual(['完整回复', '重试回复']);
  expect(entries.map((e) => e.attemptId)).toEqual(['first', 'second']);
  expect(entries[0]?.at).toBe(Date.parse('2026-10-23T06:00:01Z'));
  expect(
    agentActivity([{ ...event('bad', 'first', 'bad'), payload: { text: 123 } }], ['task']),
  ).toEqual([]);
  const final = event('a', 'first', '已完成');
  const replay = [
    { ...final, payload: { ...final.payload, state: 'complete', artifactId: 'log' } },
    final,
  ];
  expect(agentActivity(replay, ['task'])[0]).toMatchObject({
    text: '已完成',
    state: 'complete',
    artifactId: 'log',
  });
});
