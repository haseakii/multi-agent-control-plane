import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectPolicySchema, AcpPermissionReviewSchema } from '@control-plane/core';
import { agentPermissionDecision } from './agent-permission-policy.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'permission-policy-'));
  dirs.push(root);
  const policy = ProjectPolicySchema.parse({
    id: 'p',
    revision: 1,
    updatedAt: new Date().toISOString(),
    tools: {},
    gitMerge: 'ask',
    requireEnforcedExecution: false,
    agentPermissions: { workspaceFiles: 'auto' },
  });
  const review = AcpPermissionReviewSchema.parse({
    version: 1,
    status: 'complete',
    tool: 'edit_file',
    action: 'file.write',
    target: join(root, 'app.js'),
    parameters: { resolved: { fileOperation: 'write' } },
    provenance: {},
    presence: {},
    reasons: [],
    historyUsed: false,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  return { root, policy, review, workspace: { rootPath: root, isolated: true } };
}
it('automatically approves only adapter-resolved isolated file operations', () => {
  const f = fixture();
  expect(agentPermissionDecision(f.policy, f.review, f.workspace)).toBe('auto');
  expect(
    agentPermissionDecision(
      f.policy,
      { ...f.review, parameters: { rawInput: { fileOperation: 'write' } } },
      f.workspace,
    ),
  ).toBe('ask');
  expect(agentPermissionDecision(f.policy, f.review, { ...f.workspace, isolated: false })).toBe(
    'ask',
  );
});
it('keeps incomplete requests, sensitive files and commands manual; honors explicit denials', () => {
  const f = fixture();
  for (const target of [
    join(f.root, '.env'),
    join(f.root, '.git/config'),
    join(f.root, 'a:secret'),
  ])
    expect(agentPermissionDecision(f.policy, { ...f.review, target }, f.workspace)).toBe('ask');
  expect(agentPermissionDecision(f.policy, { ...f.review, status: 'truncated' }, f.workspace)).toBe(
    'ask',
  );
  expect(
    agentPermissionDecision(f.policy, { ...f.review, action: 'process.execute' }, f.workspace),
  ).toBe('ask');
  const policy = {
    ...f.policy,
    agentPermissions: {
      workspaceFiles: 'deny',
      commands: 'deny',
      outsideWorkspace: 'deny',
    } as const,
  };
  expect(agentPermissionDecision(policy, f.review, f.workspace)).toBe('deny');
  expect(
    agentPermissionDecision(policy, { ...f.review, action: 'process.execute' }, f.workspace),
  ).toBe('deny');
  expect(
    agentPermissionDecision(
      policy,
      { ...f.review, target: join(f.root, '../outside') },
      f.workspace,
    ),
  ).toBe('deny');
});
it('does not auto approve a junction redirecting a requested file', () => {
  const f = fixture(),
    outside = mkdtempSync(join(tmpdir(), 'outside-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'secret.txt'), 'synthetic');
  symlinkSync(outside, join(f.root, 'link'), 'junction');
  expect(
    agentPermissionDecision(
      f.policy,
      { ...f.review, target: join(f.root, 'link/secret.txt') },
      f.workspace,
    ),
  ).toBe('ask');
});
it('strictly denies or falls back to ask when commands: auto encounters incomplete, invalid or unverified requests', () => {
  const f = fixture();
  const autoCommandPolicy = {
    ...f.policy,
    agentPermissions: {
      ...f.policy.agentPermissions,
      commands: 'auto' as const,
    },
  };
  const commandReview = {
    ...f.review,
    action: 'process.execute',
    target: 'pnpm test',
    parameters: { resolved: { command: 'pnpm test' } },
  };

  // 1. Valid complete command is auto approved
  expect(agentPermissionDecision(autoCommandPolicy, commandReview, f.workspace)).toBe('auto');

  // 2. Status != complete MUST NOT auto-approve
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, status: 'truncated' },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, status: 'invalid' },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, status: 'missing' },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, status: 'expired' },
      f.workspace,
    ),
  ).toBe('ask');

  // 3. Reasons with integrity red flags or unverified wire must NOT auto-approve
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, reasons: ['sensitive_redacted' as const] },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, reasons: ['truncated' as const] },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, reasons: ['sdk_filtered' as const] },
      f.workspace,
    ),
  ).toBe('ask');
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, reasons: ['wire_unavailable' as const] },
      f.workspace,
    ),
  ).toBe('ask');

  // 4. Missing command content falls back to ask
  expect(
    agentPermissionDecision(
      autoCommandPolicy,
      { ...commandReview, target: null, parameters: {} },
      f.workspace,
    ),
  ).toBe('ask');

  // 5. Explicit deny ALWAYS takes priority over everything
  const denyCommandPolicy = {
    ...f.policy,
    agentPermissions: {
      ...f.policy.agentPermissions,
      commands: 'deny' as const,
    },
  };
  expect(agentPermissionDecision(denyCommandPolicy, commandReview, f.workspace)).toBe('deny');
  expect(
    agentPermissionDecision(
      denyCommandPolicy,
      { ...commandReview, status: 'invalid' },
      f.workspace,
    ),
  ).toBe('deny');
});

it('supports task-scoped auto rules and autonomous client context with integrity enforcement', () => {
  const f = fixture();
  // Policy has commands: 'ask'
  const commandReview = {
    ...f.review,
    action: 'process.execute',
    target: 'git status',
    parameters: { resolved: { command: 'git status' } },
  };

  // Without context, commands evaluates to policy setting ('ask')
  expect(agentPermissionDecision(f.policy, commandReview, f.workspace)).toBe('ask');

  // With taskScopeAutoRules for commands, auto-approved
  expect(
    agentPermissionDecision(f.policy, commandReview, f.workspace, {
      taskScopeAutoRules: new Set(['commands']),
    }),
  ).toBe('auto');

  // But if status is invalid, task-scope rule CANNOT auto-approve
  expect(
    agentPermissionDecision(f.policy, { ...commandReview, status: 'invalid' }, f.workspace, {
      taskScopeAutoRules: new Set(['commands']),
    }),
  ).toBe('ask');

  // With autonomous client context, auto-approved in authorized project
  expect(
    agentPermissionDecision(f.policy, commandReview, f.workspace, {
      originClient: {
        id: 'client-1',
        profile: 'autonomous',
        enabled: true,
        authorizedProjects: ['p'],
      },
      projectId: 'p',
    }),
  ).toBe('auto');

  // If client is disabled or downgraded to collaborate, NOT auto-approved
  expect(
    agentPermissionDecision(f.policy, commandReview, f.workspace, {
      originClient: {
        id: 'client-1',
        profile: 'collaborate',
        enabled: true,
        authorizedProjects: ['p'],
      },
      projectId: 'p',
    }),
  ).toBe('ask');
  expect(
    agentPermissionDecision(f.policy, commandReview, f.workspace, {
      originClient: {
        id: 'client-1',
        profile: 'autonomous',
        enabled: false,
        authorizedProjects: ['p'],
      },
      projectId: 'p',
    }),
  ).toBe('ask');

  // High-permission autonomous client CANNOT bypass integrity verification
  expect(
    agentPermissionDecision(f.policy, { ...commandReview, status: 'truncated' }, f.workspace, {
      originClient: {
        id: 'client-1',
        profile: 'autonomous',
        enabled: true,
        authorizedProjects: ['p'],
      },
      projectId: 'p',
    }),
  ).toBe('ask');
});
