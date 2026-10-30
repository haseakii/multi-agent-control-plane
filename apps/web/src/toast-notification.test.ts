import { describe, expect, it } from 'vitest';
import { toast } from './toast-notification';
import { getApprovalRiskLevel } from './approval-panel';

describe('ToastNotification Manager', () => {
  it('manages toast notifications correctly', () => {
    let captured: any[] = [];
    const unsubscribe = toast.subscribe((items) => {
      captured = items;
    });

    const id = toast.show('测试成功提示', 'success', 0);
    expect(captured.length).toBe(1);
    expect(captured[0].message).toBe('测试成功提示');
    expect(captured[0].type).toBe('success');

    toast.dismiss(id);
    expect(captured.length).toBe(0);

    unsubscribe();
  });
});

describe('getApprovalRiskLevel', () => {
  it('classifies dangerous tools correctly', () => {
    expect(getApprovalRiskLevel('bash', 'execute').level).toBe('danger');
    expect(getApprovalRiskLevel('run_command', 'run').level).toBe('danger');
    expect(getApprovalRiskLevel('terminal', 'cmd').level).toBe('danger');
  });

  it('classifies write tools correctly', () => {
    expect(getApprovalRiskLevel('filesystem', 'write_file').level).toBe('warning');
    expect(getApprovalRiskLevel('editor', 'patch').level).toBe('warning');
  });

  it('classifies read/inspection tools as info', () => {
    expect(getApprovalRiskLevel('filesystem', 'read_file').level).toBe('info');
    expect(getApprovalRiskLevel('status', 'check').level).toBe('info');
  });
});
