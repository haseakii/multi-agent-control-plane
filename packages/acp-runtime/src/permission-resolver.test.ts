import { describe, expect, it } from 'vitest';
import { PermissionReviewCollector, permissionWireShape } from './permission-review.js';

describe('optional ACP permission semantics', () => {
  const request = {
    toolCallId: 'call',
    name: 'example-read',
    rawInput: { path: 'example.txt' },
  };
  const collector = () =>
    new PermissionReviewCollector(Date.now, 300_000, (session, values) =>
      session === 'session' && values.name === 'example-read' && values.rawInput
        ? { tool: 'example-read', action: 'read', target: 'example.txt' }
        : null,
    );
  it('resolves explicitly registered semantics while preserving exact history/session identity', () => {
    const c = collector();
    const update = { ...request, sessionUpdate: 'tool_call' };
    c.observe('session', update, permissionWireShape(update));
    const partial = { toolCallId: 'call' };
    expect(c.review('session', partial, permissionWireShape(partial))).toMatchObject({
      status: 'complete',
      tool: 'example-read',
      action: 'read',
      target: 'example.txt',
      provenance: { name: 'history' },
      historyUsed: true,
    });
    expect(c.review('other', partial, permissionWireShape(partial)).status).toBe('missing');
    const unnamed = { ...request, name: null };
    expect(c.review('session', unnamed, permissionWireShape(unnamed)).status).toBe('missing');
    expect(
      new PermissionReviewCollector().review('session', request, permissionWireShape(request))
        .status,
    ).toBe('missing');
  });
  it('cannot bypass sensitive data, lost wire fields, or truncation checks', () => {
    for (const [input, wire, reason] of [
      [{ ...request, _meta: { secret: 'synthetic' } }, undefined, 'sensitive_redacted'],
      [request, { ...request, unknown: true }, 'sdk_filtered'],
      [{ ...request, content: ['a'.repeat(10000)] }, undefined, 'truncated'],
    ] as const) {
      const review = collector().review('session', input, permissionWireShape(wire ?? input));
      expect(review.status).not.toBe('complete');
      expect(review.reasons).toContain(reason);
    }
  });
  it('inspects only explicitly recognized metadata and still scrubs every other field', () => {
    const metadata = { mcp: { tool: 'example-read', server: 'example' }, is_mcp_tool_call: true };
    const c = new PermissionReviewCollector(
      Date.now,
      300_000,
      (_session, values) =>
        values._meta ? { tool: 'example-read', action: 'read', target: 'example.txt' } : null,
      (session, value) =>
        session === 'session' && JSON.stringify(value) === JSON.stringify(metadata),
    );
    const input = { ...request, _meta: metadata };
    expect(c.review('session', input, permissionWireShape(input)).status).toBe('complete');
    const secret = { ...input, rawInput: { ...input.rawInput, password: 'SYNTHETIC_CANARY' } };
    const secretReview = c.review('session', secret, permissionWireShape(secret));
    expect(secretReview.reasons).toContain('sensitive_redacted');
    expect(JSON.stringify(secretReview)).not.toContain('SYNTHETIC_CANARY');
    const unknown = { ...input, _meta: { ...metadata, other: true } };
    expect(c.review('session', unknown, permissionWireShape(unknown)).reasons).toContain(
      'sensitive_redacted',
    );
    expect(c.review('different', input, permissionWireShape(input)).reasons).toContain(
      'sensitive_redacted',
    );
  });
});
