import { expect, it } from 'vitest';
import { failureSummary } from '../src/failure-presentation';
it('does not turn a generic execution diagnostic into a false login requirement', () => {
  const generic =
    'Agent execution failed. Inspect runtime and authorization readiness before retrying.';
  expect(failureSummary(generic, 'EXECUTION_FAILED')).not.toContain('登录');
  expect(failureSummary('Authentication required', 'AUTH_REQUIRED')).toContain('登录');
});
it('shows the confirmed upstream failure with retained edits and retry guidance', () => {
  expect(failureSummary(undefined, 'AGENT_UPSTREAM_INTERNAL')).toContain('上游服务内部错误');
  expect(failureSummary(undefined, 'AGENT_UPSTREAM_INTERNAL')).toContain('代码改动已保留');
});
it('explains a closed connection without claiming that login expired', () => {
  const text = failureSummary(undefined, 'ACP_CONNECTION_CLOSED');
  expect(text).toContain('连接在任务完成前断开');
  expect(text).toContain('保留改动并重试');
  expect(text).not.toContain('登录');
});
