import { z } from 'zod';
import { fetchJSON, postJSON } from '@/lib/transport';
import { workspaceReadRequest } from './task-request';
import { matchesCreatedWorkspace } from './workspace-project-recovery';

const Id = z.string().min(1).max(128);
const Path = z.string().min(1).max(4096);
export const WorkspaceConfirmationSchema = z
  .object({
    workspaceId: Id,
    rootPath: Path,
    version: Id,
  })
  .strict();
export type WorkspaceConfirmation = z.infer<typeof WorkspaceConfirmationSchema>;

export const WorkspaceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed') }).strict(),
  z
    .object({
      kind: z.literal('pending'),
      path: z.string().max(4096).optional(),
      executionWorkspaceMode: z.enum(['git-worktree', 'shared-directory']).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('saved-project'), projectId: Id }).strict(),
  z
    .object({
      kind: z.literal('existing-local'),
      validationId: z.string().uuid(),
      confirmedPath: Path,
      expiresAt: z.string().datetime(),
      executionWorkspaceMode: z.enum(['git-worktree', 'shared-directory']),
    })
    .strict(),
]);
export type WorkspaceSelection = z.infer<typeof WorkspaceSelectionSchema>;
export const DirectoryPreviewSchema = z.object({
  validationId: z.string().uuid(),
  rootPath: Path,
  expiresAt: z.string().datetime(),
  notice: z.string(),
});
export type DirectoryPreview = z.infer<typeof DirectoryPreviewSchema>;

const Project = z.object({ id: Id, name: z.string(), defaultBossAgentId: Id.optional() });
const WorkspaceSnapshotSchema = z.object({
  projects: z.array(Project),
  workspaces: z.array(z.object({ id: Id, projectId: Id, rootPath: Path.optional() })),
  workspaceConfigs: z.array(
    z.object({
      id: Id,
      sourceWorkspaceId: Id,
      mode: z.enum(['task-local', 'git-worktree', 'shared-directory']),
    }),
  ),
  directoryBindings: z.array(
    z.object({
      id: Id,
      projectId: Id,
      rootPath: Path,
      confirmationVersion: Id.optional(),
    }),
  ),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export const readWorkspaceSnapshot = () =>
  workspaceReadRequest((signal) =>
    fetchJSON('/api/control-center?view=conversation', { signal }, WorkspaceSnapshotSchema),
  );
export const validateWorkspaceDirectory = (path: string) =>
  postJSON('/api/directories/validate', { path: Path.parse(path) }, DirectoryPreviewSchema);

export function describeProjectWorkspace(snapshot: WorkspaceSnapshot, projectId: string) {
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('这个项目已不可用，请重新选择工作目录。');
  const config = snapshot.workspaceConfigs.find((item) => item.id === projectId);
  const workspace = snapshot.workspaces.find((item) => item.id === config?.sourceWorkspaceId);
  if (!config || !workspace) throw new Error('项目工作目录信息不完整，请刷新后重试。');
  const binding = snapshot.directoryBindings.find((item) => item.id === workspace.id);
  if (binding && !binding.confirmationVersion)
    throw new Error('无法取得当前目录确认信息，请刷新后重试。');
  return {
    project,
    rootPath: binding?.rootPath ?? workspace.rootPath,
    mode: config.mode,
    confirmation: binding
      ? WorkspaceConfirmationSchema.parse({
          workspaceId: binding.id,
          rootPath: binding.rootPath,
          version: binding.confirmationVersion,
        })
      : undefined,
  };
}
export type ProjectWorkspace = ReturnType<typeof describeProjectWorkspace>;
export const readProjectWorkspace = async (projectId: string) =>
  describeProjectWorkspace(await readWorkspaceSnapshot(), projectId);

/** Resolves only project metadata; execution always requires a separate explicit send. */
export async function resolveWorkspaceProject(
  choice: WorkspaceSelection,
  objective: string,
  newProjectId: string,
): Promise<string> {
  let selection = WorkspaceSelectionSchema.parse(choice);
  if (selection.kind === 'saved-project') {
    await readProjectWorkspace(selection.projectId);
    return selection.projectId;
  }
  const recover = async () => {
    const snapshot = await readWorkspaceSnapshot();
    if (!snapshot.projects.some((project) => project.id === newProjectId)) return undefined;
    const workspace = describeProjectWorkspace(snapshot, newProjectId);
    if (!matchesCreatedWorkspace(workspace, selection))
      throw new Error('上次创建的项目目录与当前选择不一致，请核对工作目录后再发送。');
    return workspace.project.id;
  };
  const existing = await recover();
  if (existing) return existing;
  if (selection.kind === 'pending') throw new Error('请先检查工作目录，或选择新建空目录。');
  if (selection.kind === 'existing-local' && Date.parse(selection.expiresAt) <= Date.now()) {
    // Writing a goal may outlast the short preview token. Refresh only metadata;
    // the caller still requires explicit confirmation before starting execution.
    const fresh = await validateWorkspaceDirectory(selection.confirmedPath);
    if (fresh.rootPath !== selection.confirmedPath)
      throw new Error(
        `实际目录已变化：原目录 ${selection.confirmedPath}，当前目录 ${fresh.rootPath}。请核对后重新检查目录；任务尚未启动。`,
      );
    selection = {
      ...selection,
      validationId: fresh.validationId,
      expiresAt: fresh.expiresAt,
      confirmedPath: fresh.rootPath,
    };
  }
  try {
    const project = await postJSON(
      '/api/projects',
      {
        id: Id.parse(newProjectId),
        name: z.string().trim().min(1).parse(objective).slice(0, 70),
        workspace:
          selection.kind === 'managed'
            ? { kind: 'managed' }
            : {
                kind: 'existing-local',
                validationId: selection.validationId,
                confirmedPath: selection.confirmedPath,
              },
        ...(selection.kind === 'existing-local'
          ? { executionWorkspaceMode: selection.executionWorkspaceMode }
          : {}),
      },
      Project,
    );
    return project.id;
  } catch (error) {
    // The browser may replay a request whose response was lost and receive 409.
    // Recover by our stable ID and verify its actual workspace before continuing.
    const created = await recover();
    if (created) return created;
    throw error;
  }
}

export const workspaceModeLabel = (mode: ProjectWorkspace['mode']) =>
  ({
    'task-local': '每个协作者使用独立空目录',
    'git-worktree': '在独立 Git 工作区中处理',
    'shared-directory': '直接使用所选目录',
  })[mode];
