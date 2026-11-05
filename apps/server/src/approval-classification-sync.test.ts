import { describe, expect, it } from 'vitest';
import {
  classifyApprovalOperation as coreClassify,
  canRememberApprovalRule as coreCanRemember,
} from '@control-plane/core';
import {
  classifyApprovalOperation as wbClassify,
  canRememberApproval as wbCanRemember,
} from '../../../integrations/hermes-workbench/src/approval-classification.js';

describe('approval classification cross-consistency (P2-01)', () => {
  it('strictly guarantees identical classification and memory eligibility between core and workbench', () => {
    const testCases: Array<{
      input: Parameters<typeof coreClassify>[0];
      description: string;
    }> = [
      { input: { action: 'process.execute' }, description: 'process.execute action' },
      { input: { action: 'command.execute' }, description: 'command.execute action' },
      { input: { action: 'other', tool: 'run_command' }, description: 'run_command tool' },
      { input: { action: 'other', tool: 'bash' }, description: 'bash tool' },
      { input: { action: 'other', tool: 'exec' }, description: 'exec tool' },
      { input: { action: 'file.read' }, description: 'file.read action' },
      { input: { action: 'file.write' }, description: 'file.write action' },
      { input: { action: 'file.workspace' }, description: 'file.workspace action' },
      { input: { action: 'file.create' }, description: 'file.create action' },
      { input: { action: 'file.delete' }, description: 'file.delete action' },
      { input: { action: 'file.edit' }, description: 'file.edit action' },
      { input: { action: 'workspace.read' }, description: 'workspace.read action' },
      { input: { action: 'workspace.write' }, description: 'workspace.write action' },
      { input: { action: 'other', tool: 'read_file' }, description: 'read_file tool' },
      { input: { action: 'other', tool: 'write' }, description: 'write tool' },
      { input: { action: 'other', tool: 'read' }, description: 'read tool' },
      { input: { action: 'other', tool: 'edit_file' }, description: 'edit_file tool' },
      { input: { action: 'other', tool: 'create_file' }, description: 'create_file tool' },
      { input: { action: 'file.outside_workspace' }, description: 'file.outside_workspace action' },
      { input: { action: 'workspace.outside' }, description: 'workspace.outside action' },
      { input: { action: 'file.outside' }, description: 'file.outside action' },
      {
        input: { action: 'file.read', boundary: 'outside_workspace' },
        description: 'file.read with outside_workspace boundary',
      },
      { input: { action: 'acp.network' }, description: 'acp.network unknown action' },
      { input: { action: 'acp.browse' }, description: 'acp.browse unknown action' },
      { input: { action: 'custom.unauthorized' }, description: 'custom unauthorized action' },
      {
        input: {
          action: 'process.execute',
          acp: { review: { action: 'file.outside_workspace', tool: 'bash' } },
        },
        description: 'ACP review outside workspace override',
      },
      {
        input: {
          action: 'unknown',
          acp: { review: { action: 'process.execute', tool: 'bash' } },
        },
        description: 'ACP review command execution override',
      },
      {
        input: {
          action: 'unknown',
          acp: { review: { action: 'file.write', tool: 'edit_file' } },
        },
        description: 'ACP review workspace file override',
      },
    ];

    for (const { input, description } of testCases) {
      const coreCategory = coreClassify(input);
      const wbCategory = wbClassify(input);
      expect(wbCategory, `Category mismatch for ${description}`).toBe(coreCategory);

      const coreRemember = coreCanRemember(input);
      const wbRemember = wbCanRemember(input);
      expect(wbRemember, `canRemember mismatch for ${description}`).toBe(coreRemember);
    }
  });
});
