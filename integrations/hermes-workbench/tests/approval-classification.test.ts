import { describe, expect, it } from 'vitest';
import { classifyApprovalOperation, canRememberApproval } from '../src/approval-classification';

describe('workbench approval classification', () => {
  it('correctly classifies commands and allows remember', () => {
    expect(classifyApprovalOperation({ action: 'process.execute' })).toBe('commands');
    expect(canRememberApproval({ action: 'process.execute' })).toBe(true);
    expect(canRememberApproval({ action: 'custom', tool: 'run_command' })).toBe(true);
  });

  it('correctly classifies workspace files and allows remember', () => {
    expect(classifyApprovalOperation({ action: 'file.read' })).toBe('workspaceFiles');
    expect(canRememberApproval({ action: 'file.read' })).toBe(true);
    expect(canRememberApproval({ action: 'file.write' })).toBe(true);
    expect(canRememberApproval({ action: 'file.workspace' })).toBe(true);
    expect(canRememberApproval({ action: 'custom', tool: 'edit_file' })).toBe(true);
  });

  it('strictly rejects outside workspace and unknown actions from remember', () => {
    expect(classifyApprovalOperation({ action: 'file.outside_workspace' })).toBe(
      'outsideWorkspace',
    );
    expect(canRememberApproval({ action: 'file.outside_workspace' })).toBe(false);
    expect(classifyApprovalOperation({ action: 'acp.network' })).toBe('unknown');
    expect(canRememberApproval({ action: 'acp.network' })).toBe(false);
  });
});
