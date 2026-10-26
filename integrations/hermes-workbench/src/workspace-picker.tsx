import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeProjectWorkspace,
  readProjectWorkspace,
  readWorkspaceSnapshot,
  validateWorkspaceDirectory,
  workspaceModeLabel,
  type DirectoryPreview,
  type ProjectWorkspace,
  type WorkspaceConfirmation,
  type WorkspaceSelection,
  type WorkspaceSnapshot,
} from './workspace-api';
import s from './workspace-picker.module.css';

const message = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed/i.test(raw))
    return '暂时无法连接操作台服务，请检查服务是否正在运行，然后重试。';
  if (raw.includes('Directory is missing, not a supported readable local directory'))
    return '这个目录不可用。请选择操作台安装、数据目录以外的已有普通本地目录；目录须可读取，且不能是快捷链接或网络目录。';
  if (raw.includes('Use an explicit absolute local directory'))
    return '请填写完整的本机目录路径，例如 D:\\projects\\my-app。暂不支持相对路径、网络目录或凭据目录。';
  if (raw.includes('Drive and user-home roots cannot be bound'))
    return '请选择具体项目文件夹，不能直接使用磁盘根目录或用户主目录。';
  if (raw.includes('already bound to a project'))
    return '这个目录已关联到项目。请切换为“使用已有项目”并选择它。';
  if (
    raw.includes('Validate and confirm the displayed actual directory again') ||
    raw.includes('Directory identity changed')
  )
    return '目录检查已失效或目录发生变化，请再次点击“检查目录”。';
  if (/^HTTP \d+:/.test(raw)) return '目录请求未完成，请稍后重试；若服务刚刚重启，请重新检查目录。';
  return raw;
};

/** A collapsed, optional choice beside the composer; selection never starts an Agent. */
export function WorkspacePicker({
  value,
  onChange,
  disabled = false,
  projectName,
}: {
  value: WorkspaceSelection;
  onChange: (selection: WorkspaceSelection) => void;
  disabled?: boolean;
  projectName?: string;
}) {
  const [mode, setMode] = useState<'managed' | 'saved-project' | 'existing-local'>(
    value.kind === 'pending' ? 'existing-local' : value.kind,
  );
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [path, setPath] = useState(
    value.kind === 'existing-local'
      ? value.confirmedPath
      : value.kind === 'pending'
        ? (value.path ?? '')
        : '',
  );
  const [preview, setPreview] = useState<DirectoryPreview>();
  const [executionMode, setExecutionMode] = useState<'git-worktree' | 'shared-directory'>(
    value.kind === 'existing-local' || value.kind === 'pending'
      ? (value.executionWorkspaceMode ?? 'git-worktree')
      : 'git-worktree',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    if (value.kind !== 'pending') setMode(value.kind);
  }, [value.kind]);
  useEffect(
    () => () => {
      ++request.current;
    },
    [],
  );
  const loadProjects = async () => {
    try {
      setSnapshot(await readWorkspaceSnapshot());
      setError('');
    } catch (error) {
      setError(message(error));
    }
  };
  const invalidate = (nextPath = path) => {
    ++request.current;
    setPreview(undefined);
    setError('');
    onChange({ kind: 'pending', path: nextPath, executionWorkspaceMode: executionMode });
  };
  const validate = async () => {
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    setPreview(undefined);
    onChange({ kind: 'pending', path, executionWorkspaceMode: executionMode });
    try {
      const result = await validateWorkspaceDirectory(path);
      if (ticket !== request.current) return;
      setPreview(result);
      onChange({
        kind: 'existing-local',
        validationId: result.validationId,
        confirmedPath: result.rootPath,
        expiresAt: result.expiresAt,
        executionWorkspaceMode: executionMode,
      });
    } catch (error) {
      if (ticket === request.current) setError(message(error));
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  const selectedProject =
    value.kind === 'saved-project'
      ? snapshot?.projects.find((item) => item.id === value.projectId)
      : undefined;
  let savedWorkspace: ProjectWorkspace | undefined;
  if (selectedProject && snapshot) {
    try {
      savedWorkspace = describeProjectWorkspace(snapshot, selectedProject.id);
    } catch {
      /* The send path revalidates this project and reports a specific error. */
    }
  }
  const label =
    value.kind === 'managed'
      ? '新建空目录'
      : value.kind === 'saved-project'
        ? (selectedProject?.name ?? projectName ?? '已有项目')
        : value.kind === 'existing-local'
          ? value.confirmedPath
          : '待检查目录';
  return (
    <details
      className={s.picker}
      onToggle={(event) => {
        if (event.currentTarget.open) void loadProjects();
      }}
    >
      <summary>
        工作目录 <span>{label}</span>
      </summary>
      <fieldset disabled={disabled || busy} className={s.body}>
        <label>
          这次在哪里工作？
          <select
            aria-label="工作目录来源"
            value={mode}
            onChange={(event) => {
              invalidate();
              const next = event.target.value as typeof mode;
              setMode(next);
              if (next === 'managed') onChange({ kind: 'managed' });
            }}
          >
            <option value="managed">新建空目录（默认）</option>
            <option value="saved-project">使用已有项目</option>
            <option value="existing-local">关联本机目录</option>
          </select>
        </label>
        {mode === 'managed' && (
          <small>适合文字任务或全新工作。发送时自动创建，每个协作者使用自己的工作目录。</small>
        )}
        {mode === 'saved-project' && (
          <>
            <label>
              已有项目
              <select
                aria-label="选择已有项目"
                value={value.kind === 'saved-project' ? value.projectId : ''}
                onChange={(event) =>
                  onChange(
                    event.target.value
                      ? { kind: 'saved-project', projectId: event.target.value }
                      : { kind: 'pending' },
                  )
                }
              >
                <option value="">请选择项目</option>
                {snapshot?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {savedWorkspace && (
              <small>
                {workspaceModeLabel(savedWorkspace.mode)}
                <code>{savedWorkspace.rootPath}</code>
              </small>
            )}
            <small>
              沿用项目工作目录和规则，开启新的对话。继续之前的讨论，请从左侧打开原对话。
            </small>
          </>
        )}
        {mode === 'existing-local' && (
          <>
            <label>
              本机目录路径
              <div className={s.pathInput}>
                <input
                  aria-label="本机目录路径"
                  value={path}
                  maxLength={4096}
                  placeholder="例如 D:\projects\my-app"
                  onChange={(event) => {
                    setPath(event.target.value);
                    invalidate(event.target.value);
                  }}
                />
                <button type="button" disabled={!path || busy} onClick={() => void validate()}>
                  {busy ? '检查中…' : '检查目录'}
                </button>
              </div>
            </label>
            <label>
              文件处理方式
              <select
                aria-label="文件处理方式"
                value={executionMode}
                onChange={(event) => {
                  const next = event.target.value as typeof executionMode;
                  setExecutionMode(next);
                  if (value.kind === 'existing-local')
                    onChange({ ...value, executionWorkspaceMode: next });
                  else onChange({ kind: 'pending', path, executionWorkspaceMode: next });
                }}
              >
                <option value="git-worktree">独立 Git 工作区（目录须为 Git 仓库）</option>
                <option value="shared-directory">直接使用目录（协作者会读写原文件）</option>
              </select>
            </label>
            <small>
              {executionMode === 'git-worktree'
                ? '为各协作者创建独立分支与工作区，结果需审阅后合并。'
                : '适合普通文件夹。协作者共用此目录，修改会直接写入原文件。'}
            </small>
            <small>检查目录只读取路径元数据。点击发送后，还会显示实际目录并确认本次执行。</small>
            {value.kind === 'pending' && path && (
              <small>目录选择已保留，请点击“检查目录”确认当前路径。</small>
            )}
            {preview && (
              <output className={s.validated}>
                目录已检查<code>{preview.rootPath}</code>
              </output>
            )}
          </>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
      </fieldset>
    </details>
  );
}

type PendingConfirmation = {
  workspace: ProjectWorkspace;
  action: string;
  resolve: (value: WorkspaceConfirmation) => void;
  reject: (error: Error) => void;
};

/** The caller must pass the returned token to start/chat/resume; never cache it across actions. */
export function useWorkspaceConfirmation() {
  const [pending, setPending] = useState<PendingConfirmation>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<PendingConfirmation | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => () => current.current?.reject(new Error('目录确认已取消，任务没有启动。')), []);
  useEffect(() => {
    if (pending && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [Boolean(pending)]);
  const confirmForProject = useCallback(async (projectId: string, action = '发送任务') => {
    const workspace = await readProjectWorkspace(projectId);
    if (!workspace.confirmation) return undefined;
    if (current.current) throw new Error('请先完成当前的目录确认。');
    return new Promise<WorkspaceConfirmation>((resolve, reject) => {
      const next = { workspace, action, resolve, reject };
      current.current = next;
      setError('');
      setPending(next);
    });
  }, []);
  const cancel = () => {
    const item = current.current;
    if (!item || checking) return;
    current.current = undefined;
    setPending(undefined);
    item.reject(new Error('已取消发送，输入内容已保留。'));
  };
  const accept = async () => {
    const item = current.current;
    if (!item || checking) return;
    setChecking(true);
    setError('');
    try {
      const fresh = await readProjectWorkspace(item.workspace.project.id);
      if (current.current !== item) return;
      if (!fresh.confirmation) throw new Error('工作目录已变更，请取消后重新发送。');
      if (
        JSON.stringify(fresh.confirmation) !== JSON.stringify(item.workspace.confirmation) ||
        fresh.mode !== item.workspace.mode
      ) {
        const next = { ...item, workspace: fresh };
        current.current = next;
        setPending(next);
        setError('目录或服务状态刚刚变化，请核对当前信息后再次确认。');
        return;
      }
      current.current = undefined;
      setPending(undefined);
      item.resolve(fresh.confirmation);
    } catch (error) {
      setError(message(error));
    } finally {
      setChecking(false);
    }
  };
  const confirmationDialog = pending ? (
    <div className={s.backdrop}>
      <dialog
        ref={dialog}
        className={s.dialog}
        aria-labelledby="workspace-confirm-title"
        onCancel={(event) => {
          event.preventDefault();
          cancel();
        }}
      >
        <h2 id="workspace-confirm-title">确认本次工作目录</h2>
        <p>{pending.workspace.project.name}</p>
        <code>{pending.workspace.rootPath}</code>
        <p>
          {pending.workspace.mode === 'git-worktree'
            ? '协作者会读取这个 Git 项目，并创建独立分支与工作区。修改需审阅后合并。'
            : '协作者会直接读取或修改这个目录中的文件。'}
        </p>
        <small>
          本机执行不是系统安全沙箱；控制平面无法保证拦截协作者自带的所有工具。目录源码不包含在操作台备份中。
        </small>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <footer>
          <button type="button" autoFocus disabled={checking} onClick={cancel}>
            返回编辑
          </button>
          <button
            type="button"
            disabled={checking}
            className={s.primary}
            onClick={() => void accept()}
          >
            {checking ? '核对中…' : `确认并${pending.action}`}
          </button>
        </footer>
      </dialog>
    </div>
  ) : null;
  return { confirmForProject, confirmationDialog };
}
