import { describe, expect, it } from 'vitest';
import {
  PermissionReviewCollector,
  permissionWireShape,
  redactPermissionValue,
} from './permission-review.js';

const call = () => ({
  toolCallId: 'id',
  rawInput: { tool: 'read_file', action: 'read', path: 'synthetic.txt' },
  locations: [{ path: 'synthetic.txt' }],
});
describe('bounded ACP permission review', () => {
  it.each(['basic', 'uppercase-url'])(
    'withholds %s synthetic credentials and does not mark the review complete',
    (mode) => {
      const basic = Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64');
      const secrets = [basic, 'ONLY_SYNTHETIC_URL_CANARY', 'ONLY_SYNTHETIC_QUERY_CANARY'];
      const description =
        mode === 'basic'
          ? `Authorization: Basic ${basic}`
          : 'HTTPS://synthetic-user:ONLY_SYNTHETIC_URL_CANARY@example.test/file?key=ONLY_SYNTHETIC_QUERY_CANARY';
      const input = { ...call(), rawInput: { ...call().rawInput, description } };
      const review = new PermissionReviewCollector().review(
        'one',
        input,
        permissionWireShape(input),
      );
      const leaked = secrets.some((secret) => JSON.stringify(review).includes(secret));
      expect(leaked).toBe(false);
      expect(review.status).not.toBe('complete');
    },
  );
  it('correlates exact session/tool identity, handles null and empty patches, and never guesses from titles', () => {
    const c = new PermissionReviewCollector();
    const update = { ...call(), sessionUpdate: 'tool_call' };
    c.observe('one', update, permissionWireShape(update));
    const patch = {
      toolCallId: 'id',
      sessionUpdate: 'tool_call_update',
      rawInput: null,
      locations: [],
    };
    c.observe('one', patch, permissionWireShape(patch));
    const partial = { toolCallId: 'id' };
    expect(c.review('one', partial, permissionWireShape(partial))).toMatchObject({
      status: 'complete',
      historyUsed: true,
      provenance: { rawInput: 'history', locations: 'history' },
      parameters: { locations: [] },
    });
    for (const [session, id] of [
      ['other', 'id'],
      ['one', 'other'],
    ])
      expect(
        c.review(
          session!,
          { toolCallId: id, title: 'Read a harmless file' },
          permissionWireShape({ toolCallId: id, title: 'Read a harmless file' }),
        ).status,
      ).toBe('missing');
  });
  it('expires history without refreshing old fields on null patches and isolates clearing', () => {
    let clock = 0;
    const c = new PermissionReviewCollector(() => clock, 100);
    const u = { ...call(), sessionUpdate: 'tool_call' };
    c.observe('one', u, permissionWireShape(u));
    c.observe('two', u, permissionWireShape(u));
    c.clear('two');
    clock = 99;
    const p = { toolCallId: 'id', sessionUpdate: 'tool_call_update', rawInput: null };
    c.observe('one', p, permissionWireShape(p));
    clock = 100;
    const q = { toolCallId: 'id' };
    expect(c.review('one', q, permissionWireShape(q))).toMatchObject({
      status: 'expired',
      reasons: expect.arrayContaining(['history_expired']),
    });
    expect(c.review('two', q, permissionWireShape(q)).status).toBe('missing');
    c.clear();
    expect(c.review('one', q, permissionWireShape(q)).historyUsed).toBe(false);
  });
  it('evicts bounded history and does not reuse omitted raw input for a new tool_call', () => {
    const c = new PermissionReviewCollector();
    for (let i = 0; i < 33; i++) {
      const u = { ...call(), toolCallId: String(i), sessionUpdate: 'tool_call' };
      c.observe('one', u, permissionWireShape(u));
    }
    const q = { toolCallId: '0' };
    expect(c.review('one', q, permissionWireShape(q)).historyUsed).toBe(false);
    const reset = { toolCallId: '32', sessionUpdate: 'tool_call', title: 'new' };
    c.observe('one', reset, permissionWireShape(reset));
    expect(
      c.review('one', { toolCallId: '32' }, permissionWireShape({ toolCallId: '32' })).tool,
    ).toBeNull();
  });
  it('distinguishes SDK default/drop from upstream omission and fails closed without wire evidence', () => {
    const c = new PermissionReviewCollector();
    const raw = { ...call(), title: 42, extra: { secret: 'CANARY' } };
    const sdk = { ...call(), title: undefined };
    expect(c.review('one', sdk, permissionWireShape(raw))).toMatchObject({
      status: 'invalid',
      reasons: ['sdk_filtered'],
      presence: { title: { wire: 'number', sdk: 'absent' } },
    });
    expect(c.review('one', call()).reasons).toContain('wire_unavailable');
  });
  it('does not report redaction for explicit null or empty JSON values under sensitive keys', () => {
    for (const empty of [null, {}, []]) {
      const input = {
        ...call(),
        _meta: empty,
        rawOutput: empty,
        rawInput: { ...call().rawInput, password: empty, headers: empty },
      };
      expect(redactPermissionValue(input)).toEqual({
        value: input,
        redacted: false,
        truncated: false,
      });
      const review = new PermissionReviewCollector().review(
        'one',
        input,
        permissionWireShape(input),
      );
      expect(review.reasons).not.toContain('sensitive_redacted');
      expect(review.status).toBe('complete');
    }
  });
  it('still withholds every nonempty metadata object or array and scalar metadata value', () => {
    for (const value of [{ trace: {} }, { detail: 'SYNTHETIC_CANARY' }, [null], false, 0, '']) {
      const input = { ...call(), _meta: value };
      const safe = redactPermissionValue(input);
      expect(safe).toEqual({
        value: { ...call(), _meta: '[withheld]' },
        redacted: true,
        truncated: false,
      });
      expect(JSON.stringify(safe)).not.toContain('SYNTHETIC_CANARY');
      const review = new PermissionReviewCollector().review(
        'one',
        input,
        permissionWireShape(input),
      );
      expect(review.reasons).toContain('sensitive_redacted');
      expect(review.status).toBe('invalid');
    }
  });
  it('redacts nested/JSON/CLI/URL/pair secrets with one total UTF-8 budget', () => {
    const input = {
      ...call(),
      rawInput: {
        ...call().rawInput,
        password: 'CANARY_1',
        nested: { headers: { a: 'CANARY_2' } },
        json: '{"access_token":"CANARY_3"}',
        cli: ['--token', 'CANARY_4'],
        pair: { name: 'TOKEN', value: 'CANARY_5' },
        url: 'https://user:CANARY_6@example.test/?token=CANARY_7',
        text: 'Bearer CANARY_8',
      },
    };
    const safe = redactPermissionValue(input);
    expect(JSON.stringify(safe)).not.toContain('CANARY');
    const c = new PermissionReviewCollector();
    const large = { ...call(), rawInput: { ...call().rawInput, description: '字'.repeat(50000) } };
    const review = c.review('one', large, permissionWireShape(large));
    expect(review.status).toBe('truncated');
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(review)).not.toContain('\uFFFD');
  });

  it('infers tool, action, and target in generic fallback when resolver is not provided', () => {
    const c = new PermissionReviewCollector();
    const executeCall = {
      toolCallId: 'call-1',
      kind: 'execute',
      title: '调试',
      rawInput: {
        CommandLine: 'dir C:\\Users\\admin\\.gemini\\mcp\\fleet',
        Cwd: 'C:\\Users\\admin\\workspace',
        toolSummary: '调试',
      },
    };
    const review = c.review('one', executeCall, permissionWireShape(executeCall));
    expect(review.status).toBe('complete');
    expect(review.tool).toBe('run_command');
    expect(review.action).toBe('process.execute');
    expect(review.target).toBe('C:\\Users\\admin\\workspace');
    expect(review.reasons).toEqual([]);

    const callWithoutKind = {
      toolCallId: 'call-2',
      rawInput: {
        CommandLine: 'dir C:\\Users\\admin\\.gemini\\mcp\\fleet',
        Cwd: 'C:\\Users\\admin\\workspace',
      },
    };
    const review2 = c.review('one', callWithoutKind, permissionWireShape(callWithoutKind));
    expect(review2.status).toBe('complete');
    expect(review2.tool).toBe('run_command');
    expect(review2.action).toBe('process.execute');
    expect(review2.target).toBe('C:\\Users\\admin\\workspace');
    expect(review2.parameters).toMatchObject({
      resolved: {
        command: 'dir C:\\Users\\admin\\.gemini\\mcp\\fleet',
        workingDirectory: 'C:\\Users\\admin\\workspace',
      },
    });
    expect(review2.reasons).toEqual([]);
  });
});
