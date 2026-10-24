import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { InstructionSubmission } from './instruction-submission';
import { InstructionHistory, TaskInstructionPanel } from './task-instruction-panel';

it('reuses an uncertain request key and blocks double click or changed-body retry', () => {
  let id = 0;
  const controller = new InstructionSubmission(() => String(++id));
  const first = controller.begin(' Input ');
  expect(first).toEqual({ content: 'Input', idempotencyKey: '1' });
  expect(controller.begin('Input')).toBeUndefined();
  controller.finish('unknown');
  expect(controller.begin('Changed')).toBeUndefined();
  expect(controller.begin('Input')).toEqual(first);
  controller.finish('confirmed');
  expect(controller.begin('Input')?.idempotencyKey).toBe('2');
});
it('allows a fresh corrected request after a definitive client rejection and bounds empty/large input', () => {
  let id = 0;
  const controller = new InstructionSubmission(() => String(++id));
  expect(controller.begin(' ')).toBeUndefined();
  expect(controller.begin('x'.repeat(4001))).toBeUndefined();
  controller.begin('First');
  controller.finish('rejected');
  expect(controller.begin('Corrected')).toEqual({ content: 'Corrected', idempotencyKey: '2' });
});
it('renders escaped input and honest persistence/round labels without claiming success or human authentication', () => {
  const html = renderToStaticMarkup(
    createElement(InstructionHistory, {
      instructions: [
        { id: '1', content: '<script>unsafe()</script>', state: 'queued' },
        { id: '2', content: 'second', state: 'claimed' },
        { id: '3', content: 'third', state: 'delivered' },
      ],
    }),
  );
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('等待下一轮');
  expect(html).toContain('已交给当前轮');
  expect(html).toContain('包含该补充的轮次已结束');
});
it('keeps submission unavailable until the task eligibility is fetched', () => {
  const html = renderToStaticMarkup(createElement(TaskInstructionPanel, { taskId: 't' }));
  expect(html).toContain('disabled=""');
  expect(html).toContain('审批仍需单独处理');
  expect(html).toContain('4000');
});
