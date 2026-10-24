import { expect, it } from 'vitest';
import { approvalOutcome, approvalSummary } from '../src/approval-summary';
it('shows resolved command and cwd verbatim without claiming a check command is safe', () => {
  const s = approvalSummary({
    review: {
      action: 'process.execute',
      parameters: {
        resolved: {
          command: 'node --check app.js && upload-private-data',
          workingDirectory: 'C:\\task',
        },
      },
    },
  });
  expect(s.command).toBe('node --check app.js && upload-private-data');
  expect(s.directory).toBe('C:\\task');
  expect(s.risk).toContain('访问网络');
  expect(s.risk).toContain('不是安全沙箱');
});
it('distinguishes timeout from rejection and approval from execution success', () => {
  expect(approvalOutcome('expired').title).toContain('未获授权');
  expect(approvalOutcome('expired').message).toContain('不等于你主动拒绝');
  expect(approvalOutcome('rejected').title).toBe('已拒绝');
  expect(approvalOutcome('approved').message).toContain('是否执行成功仍需查看');
});
it('does not promote arbitrary tool titles or raw inputs into a verified command', () => {
  const s = approvalSummary({
    review: {
      action: 'process.execute',
      title: 'safe command',
      parameters: { rawInput: { command: 'hidden' } },
    },
  });
  expect(s.command).toBeUndefined();
  expect(s.directory).toBeUndefined();
  expect(approvalSummary(null).title).toBe('执行成员操作');
});
