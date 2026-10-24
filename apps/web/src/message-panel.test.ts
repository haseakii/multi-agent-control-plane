import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MessagePanel } from './message-panel';
import type { Snapshot } from './view-model';

it('shows a persisted correlated result without claiming agent receipt and disables unavailable artifacts', () => {
  const messages = [
    {
      id: 'q',
      projectId: 'p',
      fromAgentId: 'a',
      toAgentId: 'b',
      type: 'request',
      content: '<script>synthetic question</script>',
      createdAt: '',
    },
    {
      id: 'r',
      projectId: 'p',
      fromAgentId: 'b',
      toAgentId: 'a',
      type: 'response',
      replyTo: 'q',
      artifactRefs: ['present', 'missing'],
      metadata: { origin: 'control-plane-task-result' },
      createdAt: '',
    },
  ];
  const snapshot = {
    agents: [],
    tasks: [],
    messageDeliveries: [],
    artifacts: [{ id: 'present', projectId: 'p' }],
  } as unknown as Snapshot;
  const html = renderToStaticMarkup(
    createElement(MessagePanel, { messages, snapshot, onOpenArtifact: () => {} }),
  );
  expect(html).toContain('回复已保存');
  expect(html).toContain('不代表 Agent 已读取');
  expect(html).toContain('查看结果 1');
  expect(html).toMatch(/disabled=""[^>]*>结果暂不可用/);
  expect(html).toContain('&lt;script&gt;synthetic question&lt;/script&gt;');
  expect(html).not.toContain('<script>');
});
