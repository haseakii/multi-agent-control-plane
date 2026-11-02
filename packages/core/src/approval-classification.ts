import { z } from 'zod';

export const ApprovalOperationCategorySchema = z.enum([
  'commands',
  'workspaceFiles',
  'outsideWorkspace',
  'unknown',
]);

export type ApprovalOperationCategory = z.infer<typeof ApprovalOperationCategorySchema>;

export interface ApprovalActionTarget {
  action: string;
  tool?: string | null;
  target?: string | null;
}

export interface ApprovalWithReviewLike {
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

/**
 * Classifies an approval operation into a unified category.
 * Strictly guarantees that outside-workspace actions are never miscategorized
 * as workspaceFiles, and unknown actions never receive auto-approval capabilities.
 */
export function classifyApprovalOperation(
  input: ApprovalActionTarget | ApprovalWithReviewLike,
): ApprovalOperationCategory {
  const acpReview = 'acp' in input && input.acp?.review ? input.acp.review : undefined;
  const action = (acpReview?.action ?? input.action ?? '').trim();
  const tool = (acpReview?.tool ?? ('tool' in input ? input.tool : null) ?? '').trim();

  // 1. Outside-workspace actions: must be matched first to prevent broad file prefixes from matching.
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

  // 3. In-workspace file operations: explicit exact matches only.
  // Broad startsWith('file.') is forbidden to prevent unlisted actions from being classified as workspaceFiles.
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

  // 4. Any other action (e.g. acp.network, acp.browse, custom unknown) is unknown
  return 'unknown';
}

/**
 * Determines whether an approval operation is eligible to be remembered as a task-scoped auto rule.
 * Only 'commands' and 'workspaceFiles' are supported.
 * 'outsideWorkspace' and 'unknown' strictly CANNOT be remembered.
 */
export function canRememberApprovalRule(
  input: ApprovalActionTarget | ApprovalWithReviewLike,
): boolean {
  const category = classifyApprovalOperation(input);
  return category === 'commands' || category === 'workspaceFiles';
}
