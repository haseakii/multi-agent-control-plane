import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  resolveNativeCommandPermission,
  resolveNativeToolPermission,
  validateNativeEditMetadata,
  summarizeNativeEditPermission,
} from './native-permission-resolver.js';
import { PermissionReviewCollector, permissionWireShape } from './permission-review.js';

const agentInfo = { name: 'antigravity-acp', version: '1.4.1' };
const call = {
  toolCallId: 'native-command',
  title: 'Get-ChildItem',
  kind: 'execute',
  status: 'pending',
  rawInput: { CommandLine: 'Get-ChildItem', Cwd: 'D:\\example', WaitMsBeforeAsync: 5000 },
};
const resolver = (toolCall: Record<string, unknown>) =>
  resolveNativeCommandPermission({ sessionId: 'session', agentInfo, toolCall });

describe('pinned native command review', () => {
  it('describes the complete native command even when ACP has no tool name', () => {
    const collector = new PermissionReviewCollector(Date.now, 300_000, (_session, fields) =>
      resolver(fields),
    );
    expect(collector.review('session', call, permissionWireShape(call))).toMatchObject({
      status: 'complete',
      tool: 'run_command',
      action: 'process.execute',
      target: 'D:\\example',
      parameters: { resolved: { command: 'Get-ChildItem', confinement: 'unavailable' } },
    });
  });
  it('does not guess other adapters, versions, names or native input formats', () => {
    expect(
      resolveNativeCommandPermission({
        sessionId: 'session',
        agentInfo: { ...agentInfo, version: 'next' },
        toolCall: call,
      }),
    ).toBeNull();
    for (const changed of [
      { ...call, name: 'unknown' },
      { ...call, kind: 'read' },
      { ...call, _meta: {} },
      { ...call, rawInput: { ...call.rawInput, extra: 'unknown' } },
      { ...call, rawInput: { ...call.rawInput, Cwd: 'relative' } },
    ])
      expect(resolver(changed)).toBeNull();
  });
  it('cannot make wire loss, redaction or truncated command text approvable', () => {
    const collector = new PermissionReviewCollector(Date.now, 300_000, (_session, fields) =>
      resolver(fields),
    );
    for (const [input, wire, reason] of [
      [call, { ...call, unknown: true }, 'sdk_filtered'],
      [
        { ...call, rawInput: { ...call.rawInput, CommandLine: 'echo --password synthetic' } },
        undefined,
        'sensitive_redacted',
      ],
      [
        { ...call, rawInput: { ...call.rawInput, CommandLine: 'x'.repeat(1000) } },
        undefined,
        'truncated',
      ],
    ] as const) {
      const review = collector.review('session', input, permissionWireShape(wire ?? input));
      expect(review.status).not.toBe('complete');
      expect(review.reasons).toContain(reason);
    }
  });
});

describe('pinned native file create review', () => {
  const input = {
    CodeContent: '<h1>New page</h1>',
    Description: 'Create a static page',
    Overwrite: true,
    TargetFile: 'D:/project/settings-check.html',
  };
  const create = {
    toolCallId: 'create',
    title: 'An arbitrary display title',
    kind: 'edit',
    status: 'pending',
    rawInput: input,
    locations: [{ path: input.TargetFile }],
    content: [
      {
        type: 'diff',
        path: input.TargetFile,
        newText: input.CodeContent,
        _meta: { kind: 'add' },
      },
    ],
  };
  const collector = () =>
    new PermissionReviewCollector(
      Date.now,
      300_000,
      (sessionId, toolCall) => resolveNativeToolPermission({ sessionId, agentInfo, toolCall }),
      undefined,
      (sessionId, toolCall, metadata) =>
        validateNativeEditMetadata({ sessionId, agentInfo, toolCall, metadata }),
      (sessionId, toolCall) => summarizeNativeEditPermission({ sessionId, agentInfo, toolCall }),
    );
  it('recognizes only the exact create input and matching create diff without using its title', () => {
    expect(collector().review('session', create, permissionWireShape(create))).toMatchObject({
      status: 'complete',
      tool: 'create_file',
      action: 'file.write',
      target: input.TargetFile,
      reasons: [],
      parameters: {
        resolved: { fileOperation: 'write', overwrite: true, confinement: 'unavailable' },
      },
    });
    expect(
      validateNativeEditMetadata({
        sessionId: 'session',
        agentInfo,
        toolCall: create,
        metadata: { kind: 'modify' },
      }),
    ).toBe(false);
    const changed = [
      { ...create, name: 'edit_file' },
      { ...create, kind: 'create' },
      { ...create, _meta: {} },
      { ...create, rawInput: { ...input, Overwrite: 'false' } },
      { ...create, rawInput: { ...input, unknown: true } },
      { ...create, content: [{ ...create.content[0], oldText: '' }] },
      { ...create, content: [{ ...create.content[0], newText: 'Different body' }] },
      { ...create, content: [{ ...create.content[0], path: 'D:/other.html' }] },
      { ...create, content: [{ ...create.content[0], _meta: { kind: 'modify' } }] },
      { ...create, content: [{ ...create.content[0], _meta: { kind: 'create' } }] },
      { ...create, content: [{ ...create.content[0], _meta: { kind: 'add', unknown: true } }] },
    ];
    for (const toolCall of changed)
      expect(resolveNativeToolPermission({ sessionId: 'session', agentInfo, toolCall })).toBeNull();
    expect(
      resolveNativeToolPermission({
        sessionId: 'session',
        agentInfo: { ...agentInfo, version: 'next' },
        toolCall: create,
      }),
    ).toBeNull();
  });
  it('accepts the observed non-overwriting create with a bounded instruction and rejects unknown input keys', () => {
    const actual = {
      ...create,
      rawInput: {
        ...input,
        Overwrite: false,
        Instruction: '新建 settings-check.html 静态中文页面，符合无外部依赖与品牌规范要求',
      },
    };
    expect(collector().review('session', actual, permissionWireShape(actual))).toMatchObject({
      status: 'complete',
      tool: 'create_file',
      action: 'file.write',
      reasons: [],
      parameters: { rawInput: actual.rawInput, resolved: { overwrite: false } },
    });
    for (const rawInput of [
      { ...actual.rawInput, unknown: true },
      { ...actual.rawInput, Instruction: 'x'.repeat(769) },
    ])
      expect(
        resolveNativeToolPermission({
          sessionId: 'session',
          agentInfo,
          toolCall: { ...actual, rawInput },
        }),
      ).toBeNull();
  });
  it('scans the full create body before retaining a bounded exact-byte fingerprint', () => {
    const body = '<p>完整页面内容</p>\n'.repeat(1400);
    const large = {
      ...create,
      rawInput: { ...input, CodeContent: body },
      content: [{ ...create.content[0], newText: body }],
    };
    const c = collector(),
      update = { ...large, sessionUpdate: 'tool_call' };
    c.observe('session', update, permissionWireShape(update));
    const review = c.review('session', large, permissionWireShape(large));
    const digest = `[file-content bytes=${Buffer.byteLength(body)} sha256=${createHash('sha256').update(body).digest('hex')}]`;
    expect(review).toMatchObject({
      status: 'complete',
      action: 'file.write',
      reasons: [],
      parameters: {
        rawInput: { ...input, CodeContent: digest },
        content: [{ ...create.content[0], newText: digest }],
      },
    });
    expect(JSON.stringify(review)).not.toContain(body);
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(6000);
    const secret = body + '\n--password synthetic';
    const sensitive = {
      ...large,
      rawInput: { ...input, CodeContent: secret },
      content: [{ ...create.content[0], newText: secret }],
    };
    expect(
      summarizeNativeEditPermission({ sessionId: 'session', agentInfo, toolCall: sensitive }),
    ).toBeNull();
    expect(
      collector().review('session', sensitive, permissionWireShape(sensitive)).reasons,
    ).toContain('sensitive_redacted');
    expect(
      c.review('session', large, permissionWireShape({ ...large, extra: true })).reasons,
    ).toContain('sdk_filtered');
  });
});

describe('pinned native file edit review', () => {
  const input = {
    AllowMultiple: false,
    Description: 'Add task counter',
    EndLine: 23,
    Instruction: 'Add an accessible counter',
    ReplacementContent: '<span>显示 3 / 3 项</span>',
    StartLine: 21,
    TargetContent: '<span>任务</span>',
    TargetFile: 'D:/project/index.html',
  };
  const edit = {
    toolCallId: 'edit',
    title: 'Run edit_file?',
    kind: 'edit',
    status: 'pending',
    rawInput: input,
    locations: [{ path: input.TargetFile, line: 21 }],
    content: [
      {
        type: 'diff',
        path: input.TargetFile,
        oldText: input.TargetContent,
        newText: input.ReplacementContent,
        _meta: { kind: 'modify' },
      },
    ],
  };
  const collector = () =>
    new PermissionReviewCollector(
      Date.now,
      300_000,
      (sessionId, toolCall) => resolveNativeToolPermission({ sessionId, agentInfo, toolCall }),
      undefined,
      (sessionId, toolCall, metadata) =>
        validateNativeEditMetadata({ sessionId, agentInfo, toolCall, metadata }),
      (sessionId, toolCall) => summarizeNativeEditPermission({ sessionId, agentInfo, toolCall }),
    );
  it('presents the exact edit and known diff metadata without granting permission', () => {
    const c = collector();
    const update = { ...edit, sessionUpdate: 'tool_call' };
    c.observe('session', update, permissionWireShape(update));
    const review = c.review('session', edit, permissionWireShape(edit));
    expect(review).toMatchObject({
      status: 'complete',
      tool: 'edit_file',
      action: 'file.write',
      target: input.TargetFile,
      reasons: [],
      parameters: {
        rawInput: input,
        content: edit.content,
        resolved: { confinement: 'unavailable' },
      },
    });
  });
  it('leaves unknown metadata, mismatched diffs, secrets and oversized edits unapprovable', () => {
    const changed = [
      { ...edit, content: [{ ...edit.content[0], _meta: { kind: 'modify', extra: 'unknown' } }] },
      { ...edit, content: [{ ...edit.content[0], path: 'D:/other.txt' }] },
      { ...edit, rawInput: { ...input, ReplacementContent: '--password synthetic' } },
      { ...edit, rawInput: { ...input, ReplacementContent: 'x'.repeat(9000) } },
    ];
    for (const call of changed)
      expect(collector().review('session', call, permissionWireShape(call)).status).not.toBe(
        'complete',
      );
    expect(
      collector().review('session', edit, permissionWireShape({ ...edit, extra: true })).reasons,
    ).toContain('sdk_filtered');
    expect(
      resolveNativeToolPermission({
        sessionId: 'session',
        agentInfo: { ...agentInfo, version: 'next' },
        toolCall: edit,
      }),
    ).toBeNull();
    expect(
      new PermissionReviewCollector().review('session', edit, permissionWireShape(edit)).reasons,
    ).toContain('sensitive_redacted');
  });

  it('validates and fingerprints large edits across correlated notifications without truncation', () => {
    const oldText = 'const original = 1;\n'.repeat(1000);
    const newText = 'const replacement = 2;\n'.repeat(1200);
    const large = {
      ...edit,
      rawInput: { ...input, TargetContent: oldText, ReplacementContent: newText },
      content: [{ ...edit.content[0], oldText, newText }],
    };
    const c = collector(),
      update = { ...large, sessionUpdate: 'tool_call' };
    c.observe('session', update, permissionWireShape(update));
    const review = c.review('session', large, permissionWireShape(large));
    expect(review).toMatchObject({
      status: 'complete',
      reasons: [],
      target: input.TargetFile,
      parameters: { resolved: { fileOperation: 'write' } },
    });
    expect(JSON.stringify(review)).toContain('file-content bytes=');
    expect(JSON.stringify(review)).not.toContain(newText);
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(6000);
    expect(
      c.review('session', large, permissionWireShape({ ...large, extra: true })).reasons,
    ).toContain('sdk_filtered');
    const secret = newText + '\n--password synthetic';
    const sensitive = {
      ...large,
      rawInput: { ...large.rawInput, ReplacementContent: secret },
      content: [{ ...large.content[0], newText: secret }],
    };
    expect(
      collector().review('session', sensitive, permissionWireShape(sensitive)).reasons,
    ).toContain('sensitive_redacted');
    const json = JSON.stringify([
      ...Array(30).fill('ordinary source line'.repeat(3)),
      { password: 'synthetic' },
    ]);
    expect(
      summarizeNativeEditPermission({
        sessionId: 'session',
        agentInfo,
        toolCall: {
          ...large,
          rawInput: { ...large.rawInput, ReplacementContent: json },
          content: [{ ...large.content[0], newText: json }],
        },
      }),
    ).toBeNull();
    const mismatch = { ...large, content: [{ ...large.content[0], newText: oldText }] };
    expect(collector().review('session', mismatch, permissionWireShape(mismatch)).status).not.toBe(
      'complete',
    );
  });
});
