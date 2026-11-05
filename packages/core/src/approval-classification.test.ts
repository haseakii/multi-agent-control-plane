import { describe, expect, it } from 'vitest';
import { classifyApprovalOperation, canRememberApprovalRule } from './approval-classification.js';

describe('classifyApprovalOperation', () => {
  it('correctly classifies command executions', () => {
    expect(classifyApprovalOperation({ action: 'process.execute' })).toBe('commands');
    expect(classifyApprovalOperation({ action: 'command.execute' })).toBe('commands');
    expect(classifyApprovalOperation({ action: 'unknown.act', tool: 'run_command' })).toBe(
      'commands',
    );
    expect(classifyApprovalOperation({ action: 'custom', tool: 'bash' })).toBe('commands');
    expect(classifyApprovalOperation({ action: '', tool: 'exec' })).toBe('commands');
    expect(
      classifyApprovalOperation({
        action: 'acp.permission',
        acp: { review: { action: 'process.execute', tool: 'run_command' } },
      }),
    ).toBe('commands');
  });

  it('correctly classifies workspace file operations', () => {
    expect(classifyApprovalOperation({ action: 'file.read' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'file.write' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'file.workspace' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'file.create' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'workspace.read' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'workspace.write' })).toBe('workspaceFiles');
    expect(classifyApprovalOperation({ action: 'custom', tool: 'read_file' })).toBe(
      'workspaceFiles',
    );
    expect(classifyApprovalOperation({ action: 'custom', tool: 'edit_file' })).toBe(
      'workspaceFiles',
    );
    expect(
      classifyApprovalOperation({
        action: 'acp.permission',
        acp: { review: { action: 'file.write', tool: 'edit_file' } },
      }),
    ).toBe('workspaceFiles');
  });

  it('strictly classifies outside-workspace operations without fallback to workspaceFiles', () => {
    expect(classifyApprovalOperation({ action: 'file.outside_workspace' })).toBe(
      'outsideWorkspace',
    );
    expect(classifyApprovalOperation({ action: 'workspace.outside' })).toBe('outsideWorkspace');
    expect(classifyApprovalOperation({ action: 'file.outside' })).toBe('outsideWorkspace');
    expect(
      classifyApprovalOperation({
        action: 'file.outside_workspace',
        tool: 'read_file',
      }),
    ).toBe('outsideWorkspace');
    expect(
      classifyApprovalOperation({
        action: 'acp.permission',
        boundary: 'outside_workspace',
      }),
    ).toBe('outsideWorkspace');
    expect(
      classifyApprovalOperation({
        action: 'acp.permission',
        acp: { review: { action: 'file.outside_workspace', tool: 'read_file' } },
      }),
    ).toBe('outsideWorkspace');
  });

  it('strictly classifies unknown, network, browse and unspecified operations as unknown', () => {
    expect(classifyApprovalOperation({ action: 'acp.network' })).toBe('unknown');
    expect(classifyApprovalOperation({ action: 'acp.browse' })).toBe('unknown');
    expect(classifyApprovalOperation({ action: 'arbitrary.custom.op' })).toBe('unknown');
    expect(classifyApprovalOperation({ action: 'file.unknown_extension_operation' })).toBe(
      'unknown',
    );
    expect(classifyApprovalOperation({ action: '' })).toBe('unknown');
  });

  it('enforces canRememberApprovalRule boundaries', () => {
    expect(canRememberApprovalRule({ action: 'process.execute' })).toBe(true);
    expect(canRememberApprovalRule({ action: 'file.read' })).toBe(true);
    expect(canRememberApprovalRule({ action: 'file.write' })).toBe(true);
    // outsideWorkspace and unknown strictly cannot be remembered!
    expect(canRememberApprovalRule({ action: 'file.outside_workspace' })).toBe(false);
    expect(canRememberApprovalRule({ action: 'acp.network' })).toBe(false);
    expect(canRememberApprovalRule({ action: 'arbitrary' })).toBe(false);
  });
});
