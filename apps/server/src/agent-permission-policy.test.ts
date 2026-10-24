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
