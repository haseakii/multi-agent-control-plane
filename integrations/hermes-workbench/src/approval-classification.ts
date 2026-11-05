export type ApprovalOperationCategory =
  | 'commands'
  | 'workspaceFiles'
  | 'outsideWorkspace'
  | 'unknown';

export interface ApprovalActionReviewLike {
  action: string;
  boundary?: string | null;
  acp?: {
    review: {
      action: string | null;
      tool?: string | null;
      target?: string | null;
    };
  } | null;
}

export function classifyApprovalOperation(
  input: ApprovalActionReviewLike | { action: string; tool?: string | null },
): ApprovalOperationCategory {
  const acpReview = 'acp' in input && input.acp?.review ? input.acp.review : undefined;
  const action = (acpReview?.action ?? input.action ?? '').trim();
  const tool = (acpReview?.tool ?? ('tool' in input ? input.tool : null) ?? '').trim();

  // 1. Outside-workspace actions: must be checked first
  if (
    action === 'file.outside_workspace' ||
    action === 'workspace.outside' ||
    action === 'file.outside' ||
    ('boundary' in input && input.boundary === 'outside_workspace')
  ) {
    return 'outsideWorkspace';
  }

  // 2. Command execution operations
  if (
    action === 'process.execute' ||
    action === 'command.execute' ||
    tool === 'run_command' ||
    tool === 'bash' ||
    tool === 'exec'
  ) {
    return 'commands';
  }

  // 3. In-workspace file operations: explicit exact matches only
  const isExactFileAction =
    action === 'file.read' ||
    action === 'file.write' ||
    action === 'file.workspace' ||
    action === 'file.create' ||
    action === 'file.delete' ||
    action === 'file.edit' ||
    action === 'workspace.read' ||
    action === 'workspace.write';

  const isExactFileTool =
    tool === 'read_file' ||
    tool === 'write' ||
    tool === 'read' ||
    tool === 'edit_file' ||
    tool === 'create_file';

  if (isExactFileAction || isExactFileTool) {
    return 'workspaceFiles';
  }

  return 'unknown';
}

export function canRememberApproval(
  input: ApprovalActionReviewLike | { action: string; tool?: string | null },
): boolean {
  const category = classifyApprovalOperation(input);
  return category === 'commands' || category === 'workspaceFiles';
}
