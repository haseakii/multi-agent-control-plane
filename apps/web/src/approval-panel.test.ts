import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  approvalAvailability,
  approvalDecisionError,
  ApprovalReview,
  ApprovalPanel,
  type ApprovalItem,
} from './approval-panel';
import { HttpError } from './http';

function approval(): ApprovalItem {
  return {
    id: 'a',
    projectId: 'p',
    taskId: 't',
    action: 'acp.tool',
    resource: {},
    state: 'pending',
    enforcementMode: 'cooperative',
    decisionEligibility: {
      canApprove: true,
      canReject: true,
      reason: 'current_complete',
      checkedAt: '2026-10-21T00:00:00Z',
      validForMs: 3000,
    },
    acp: {
      attemptId: 'attempt-1',
      attemptNumber: 1,
      expiresAt: '2026-10-21T00:05:00Z',
      review: {
        version: 1,
        status: 'complete',
        tool: 'file.read',
        action: 'read',
        target: 'synthetic.txt',
        parameters: { path: 'synthetic.txt' },
        provenance: { rawInput: 'history', locations: 'request' },
        presence: {},
        reasons: [],
        historyUsed: true,
        observedAt: '2026-10-21T00:00:00Z',
        expiresAt: '2026-10-21T00:05:00Z',
      },
    },
  };
}
describe('official approval presentation', () => {
  it('never infers authority from a complete-looking review without server eligibility', () => {
    const a = approval();
    delete a.decisionEligibility;
    expect(approvalAvailability(a, true, 100, 200, false)).toMatchObject({
      canApprove: false,
      canReject: false,
    });
  });
  it.each(['stale', 'offline', 'busy', 'refreshing', 'absent', 'decided'])(
    'only removes availability for %s',
    (mode) => {
      const a = approval();
      if (mode === 'decided') a.state = 'approved';
      const result = approvalAvailability(
        a,
        mode !== 'offline',
        100,
        mode === 'stale' ? 4000 : 200,
        mode === 'busy',
        mode === 'refreshing',
        mode !== 'absent',
      );
      expect(result.canApprove).toBe(false);
      expect(result.canReject).toBe(false);
      expect(result.reason.length > 0).toBe(true);
    },
  );
  it('renders known single-use review and attributed protocol fields without a persistent-grant control', () => {
    const a = approval(),
      availability = approvalAvailability(a, true, 100, 200, false);
    const html = renderToStaticMarkup(
      createElement(ApprovalReview, {
        approval: a,
        availability,
        onClose: () => {},
        onDecision: () => {},
      }),
    );
    for (const text of [
      'file.read',
      'synthetic.txt',
      '安全参数摘要',
      '同会话、同工具调用的先前事件',
      '允许一次',
      '拒绝当前请求',
      '返回审批列表',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('checkbox');
    expect(html).not.toContain('allow_always');
  });
  it.each([
    'details_missing',
    'details_redacted',
    'details_truncated',
    'approval_expired',
    'execution_changed',
  ] as const)('cannot offer approve for server reason %s', (reason) => {
    const a = approval();
    a.decisionEligibility = {
      ...a.decisionEligibility!,
      canApprove: false,
      canReject: reason.startsWith('details'),
      reason,
    };
    const html = renderToStaticMarkup(
      createElement(ApprovalReview, {
        approval: a,
        availability: approvalAvailability(a, true, 100, 200, false),
        onClose: () => {},
        onDecision: () => {},
      }),
    );
    expect(html).not.toContain('允许一次');
    expect(html).toContain('approval-eligibility-reason');
  });
  it('escapes summaries and does not render arbitrary generic resource payloads', () => {
    const a = approval();
    a.acp!.review.tool = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(
      createElement(ApprovalReview, {
        approval: a,
        availability: approvalAvailability(a, true, 100, 200, false),
        onClose: () => {},
        onDecision: () => {},
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    delete a.acp;
    a.resource = { password: 'DO_NOT_RENDER_RAW_GENERIC_RESOURCE' };
    expect(
      renderToStaticMarkup(
        createElement(ApprovalReview, {
          approval: a,
          availability: approvalAvailability(a, true, 100, 200, false),
          onClose: () => {},
          onDecision: () => {},
        }),
      ),
    ).not.toContain('DO_NOT_RENDER');
  });
  it('exposes only a fixed isolation diagnostic and count', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalPanel, {
        approvals: [],
        visibleIds: [],
        diagnostics: { code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED', count: 2 },
        healthy: true,
        startedAt: 100,
        busy: false,
        onRefresh: async () => {},
        onDecision: async () => {},
      }),
    );
    expect(html).toContain('APPROVAL_SENSITIVE_RECORDS_ISOLATED');
    expect(html).toContain('2');
    expect(html).not.toContain('data-approval-trigger');
  });
  it('keeps a conflict as a failed decision with its actual HTTP status', () => {
    const message = approvalDecisionError(
      new HttpError(409, 'Approval is already decided or expired.'),
    );
    expect(message).toContain('HTTP 409');
    expect(message).toContain('already decided');
    expect(message).not.toContain('已确认此审批为');
    const a = approval();
    const html = renderToStaticMarkup(
      createElement(ApprovalReview, {
        approval: a,
        availability: approvalAvailability(a, true, 100, 200, false),
        operation: { id: a.id, status: 'failed', decision: 'approve', message },
        onClose: () => {},
        onDecision: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('HTTP 409');
  });
});
