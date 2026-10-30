import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './guided-workbench.css';

import {
  taskActionEligibility,
  taskAgentId,
  taskFamily,
  messageInTaskScope,
  type Project,
  type Task,
  type Artifact,
  type Snapshot,
} from './view-model';
import { AgentCatalogPanel, type CatalogChoice } from './agent-catalog-panel';
import { AgentConnectionDetails } from './agent-connection-details';
import { ExecutionTimeline } from './execution-timeline';
import {
  ExistingDirectoryInput,
  DirectoryExecutionNotice,
  type ProjectDirectoryChoice,
} from './existing-directory-input';
import { agentLabel, taskStateLabel } from './presentation';
import { ApprovalPanel } from './approval-panel';
import { MessagePanel } from './message-panel';
import { TaskInstructionPanel } from './task-instruction-panel';
import { CollaborationProgress } from './collaboration-progress';
import { ExecutionContextPanel } from './execution-context-panel';
import { WorkspaceModePanel, TaskWorkspacePanel } from './workspace-mode-panel';
import { ProjectMemoryPanel } from './project-memory-panel';
import { WorkspaceReviewPanel } from './workspace-review-panel';
import { WorkspaceCleanupPanel } from './workspace-cleanup-panel';
import { ProjectPolicyPanel } from './project-policy-panel';
import { AgentBridgePanel } from './agent-bridge-panel';
import { AgentRemovalPanel } from './agent-removal-panel';
import { ProjectSetupPanel } from './project-setup-panel';
import { TaskRecordPanel } from './task-record-panel';
import { useControlUpdates } from './use-control-updates';
import { api, HttpError } from './http';
import { ToastContainer, toast } from './toast-notification';
import { ArtifactContentViewer } from './artifact-content-viewer';

type AgentForm = {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd: string;
  environmentAllowlist: string;
  capabilities: string;
  canBeBoss: boolean;
};

const emptyAgentForm: AgentForm = {
  id: '',
  name: '',
  command: '',
  args: '',
  cwd: '',
  environmentAllowlist: '',
  capabilities: '',
  canBeBoss: true,
};

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}

function TaskTechnicalDetails({ task, snapshot }: { task: Task; snapshot: Snapshot | null }) {
  return (
    <details className="technical-details task-technical">
      <summary>技术详情</summary>
      <dl>
        <dt>任务 ID</dt>
        <dd>{task.id}</dd>
        {task.parentTaskId ? (
          <>
            <dt>父任务 ID</dt>
            <dd>{task.parentTaskId}</dd>
          </>
        ) : null}
        <dt>原始状态</dt>
        <dd>{task.state}</dd>
        <dt>Agent ID</dt>
        <dd>{snapshot ? (taskAgentId(task, snapshot) ?? '未分配') : '未分配'}</dd>
      </dl>
    </details>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="empty">{children}</p>;
}

function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
  const canPreview =
    artifact.sizeBytes <= 65_536 &&
    (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json');

  useEffect(() => {
    if (!canPreview) {
      return;
    }
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Could not load result (HTTP ${response.status}).`);
        }
        const value = await response.text();
        if (!controller.signal.aborted) {
          setContent(value);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [canPreview, url]);

  return (
    <section className="artifact-preview" aria-label="Result preview">
      <div className="panel-heading">
        <div>
          <p className="kicker">任务结果</p>
          <h2>{artifact.id}</h2>
        </div>
        <button ref={closeButton} type="button" onClick={onClose}>
          关闭结果
        </button>
      </div>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {canPreview && !error ? (
        content === null ? (
          <p>正在加载结果…</p>
        ) : (
          <ArtifactContentViewer artifact={artifact} content={content} />
        )
      ) : null}
      {!canPreview ? <p>此结果暂不支持预览，请下载查看。</p> : null}
      <a href={url} download>
        下载结果
      </a>
    </section>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotStartedAt, setSnapshotStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogChoice | null>(null);
  const commandInput = useRef<HTMLInputElement>(null);
  const [agentForm, setAgentForm] = useState<AgentForm>(emptyAgentForm);
  const [projectName, setProjectName] = useState('');
  const [projectDirectory, setProjectDirectory] = useState<ProjectDirectoryChoice>({
    kind: 'managed',
  });
  const [directoryFormKey, setDirectoryFormKey] = useState(0);
  const [boundGoal, setBoundGoal] = useState<{
    projectId: string;
    title: string;
    objective: string;
    workspaceId: string;
    rootPath: string;
    version: string;
  } | null>(null);
  const [boundGoalAccepted, setBoundGoalAccepted] = useState(false);
  const [resumeDirectoryVersion, setResumeDirectoryVersion] = useState<string | null>(null);
  const goalDialogRef = useRef<HTMLDialogElement>(null),
    goalSubmitRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (boundGoal && !goalDialogRef.current?.open) goalDialogRef.current?.showModal();
  }, [boundGoal]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalObjective, setGoalObjective] = useState('');

  useEffect(() => {
    if (notice) toast.show(notice, 'success');
  }, [notice]);
  useEffect(() => {
    if (error) toast.show(error, 'error');
  }, [error]);
  useEffect(() => {
    if (loadError) toast.show(loadError, 'error');
  }, [loadError]);

  const goalComposerRef = useRef<HTMLDetailsElement>(null);
  const goalObjectiveRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      const saved = localStorage.getItem(`draft:goal:${selectedProjectId}`);
      if (saved && !goalObjective) {
        setGoalObjective(saved);
      }
    } catch {}
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      if (goalObjective) {
        localStorage.setItem(`draft:goal:${selectedProjectId}`, goalObjective);
      } else {
        localStorage.removeItem(`draft:goal:${selectedProjectId}`);
      }
    } catch {}
  }, [selectedProjectId, goalObjective]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'team' | 'project' | 'memory'>('team');
  const [addingAgent, setAddingAgent] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const projectDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (newProjectOpen) projectDialog.current?.showModal();
    else projectDialog.current?.close();
  }, [newProjectOpen]);
  const [contextOpen, setContextOpen] = useState(false);
  const narrow = true;
  const [taskAction, setTaskAction] = useState<{ kind: 'cancel' | 'resume'; task: Task } | null>(
    null,
  );
  const taskDialogRef = useRef<HTMLDialogElement>(null);
  const contextDialogRef = useRef<HTMLDialogElement>(null);
  const resultTrigger = useRef<{ element: HTMLElement; key: string | undefined } | null>(null);
  const contextTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = contextDialogRef.current;
    if (narrow && contextOpen && dialog && !dialog.open) dialog.showModal();
    if (!contextOpen && dialog?.open) dialog.close();
  }, [narrow, contextOpen]);
  useEffect(() => {
    setResumeDirectoryVersion(null);
    if (taskAction && !taskDialogRef.current?.open) taskDialogRef.current?.showModal();
  }, [taskAction]);
  const openContext = (trigger: HTMLElement) => {
    contextTrigger.current = trigger;
    setContextOpen(true);
  };
  const closeContext = () => {
    setContextOpen(false);
    contextDialogRef.current?.close();
    requestAnimationFrame(() => contextTrigger.current?.focus({ preventScroll: true }));
  };
  const openArtifact = (id: string, trigger: HTMLElement) => {
    resultTrigger.current = { element: trigger, key: trigger.dataset.resultTrigger };
    setSelectedArtifactId(id);
    if (narrow) openContext(trigger);
  };
  const closeArtifact = () => {
    setSelectedArtifactId(null);
    const dialog = contextDialogRef.current;
    const source = resultTrigger.current?.element;
    // A connected navigation button outside showModal() is still inert.
    // Leave the modal before restoring an external source; rebuilt list
    // sources remain inside it and use the stable key below.
    if (dialog?.open && source?.isConnected && !dialog.contains(source)) {
      setContextOpen(false);
      dialog.close();
    }
    requestAnimationFrame(() => {
      const trigger = resultTrigger.current;
      const restored = trigger?.element.isConnected
        ? trigger.element
        : Array.from(document.querySelectorAll<HTMLElement>('[data-result-trigger]')).find(
            (element) =>
              trigger?.key !== undefined && element.dataset.resultTrigger === trigger.key,
          );
      const fallback = contextDialogRef.current?.open
        ? contextDialogRef.current.querySelector<HTMLButtonElement>('button')
        : document.querySelector<HTMLElement>('.task-choice[aria-current="page"]');
      (restored ?? fallback)?.focus({ preventScroll: true });
    });
  };
  const busyRef = useRef(false);
  const snapshotRequest = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const request = ++snapshotRequest.current;
    const startedAt = performance.now();
    try {
      const value = await api<Snapshot>('/api/control-center');
      if (request === snapshotRequest.current) {
        setSnapshot(value);
        setSnapshotStartedAt(startedAt);
        setLoadError(null);
      }
    } catch (reason) {
      if (request === snapshotRequest.current) {
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, []);

  const project =
    snapshot?.projects.find((item) => item.id === selectedProjectId) ?? snapshot?.projects[0];
  const eventsLive = useControlUpdates(project?.id, loadSnapshot);
  const directoryBinding = snapshot?.directoryBindings?.find(
    (item) => item.projectId === project?.id,
  );
  const resumeBinding = snapshot?.directoryBindings?.find(
    (item) => item.projectId === taskAction?.task.projectId,
  );
  const tasks = snapshot?.tasks.filter((task) => task.projectId === project?.id) ?? [];
  const activeTask =
    tasks.find((task) => task.id === selectedTaskId) ??
    tasks.find((task) => task.state === 'waiting_approval') ??
    tasks[0];
  const artifacts =
    snapshot?.artifacts.filter((artifact) => artifact.projectId === project?.id) ?? [];
  const approvals =
    snapshot?.approvals.filter((approval) => approval.projectId === project?.id) ?? [];
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const boss = useMemo(
    () => snapshot?.agents.find((agent) => agent.definition.id === project?.defaultBossAgentId),
    [project?.defaultBossAgentId, snapshot?.agents],
  );
  const bossCandidates =
    snapshot?.agents.filter(
      (agent) =>
        agent.definition.enabled &&
        agent.definition.orchestration.canBeBoss &&
        agent.definition.controlBridge.transport === 'mcp' &&
        agent.definition.controlBridge.scopes.includes('boss.orchestration'),
    ) ?? [];

  const startReady = Boolean(
    boss &&
      boss.definition.enabled &&
      boss.definition.orchestration.canBeBoss &&
      boss.definition.controlBridge.transport === 'mcp' &&
      boss.definition.controlBridge.scopes.includes('boss.orchestration') &&
      boss.readiness.runtime === 'ready' &&
      ['ready', 'not_reported'].includes(boss.readiness.auth) &&
      snapshot?.workspaceConfigs?.some(
        (item) => item.id === project?.id && item.mode !== 'unconfigured',
      ),
  );

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(key);
    setFailedAction(null);
    setNotice(null);
    setError(null);
    try {
      await action();
      await loadSnapshot();
    } catch (reason) {
      setFailedAction(key);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectName.trim() || projectDirectory.kind === 'pending') {
      return;
    }
    await runAction('project', async () => {
      const created = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: projectName.trim(),
          ...(projectDirectory.kind === 'existing-local' ? { workspace: projectDirectory } : {}),
        }),
      });
      setSelectedProjectId(created.id);
      setSelectedArtifactId(null);
      setSelectedTaskId('');
      setProjectName('');
      setProjectDirectory({ kind: 'managed' });
      setDirectoryFormKey((value) => value + 1);
      setNewProjectOpen(false);
      setSettingsOpen(false);
      setNotice(`已创建「${created.name}」。写下你想完成的任务，也可以先保存草稿。`);
    });
  };

  const closeGoalConfirmation = () => {
    goalDialogRef.current?.close();
    setBoundGoal(null);
    setBoundGoalAccepted(false);
    requestAnimationFrame(() => goalSubmitRef.current?.focus({ preventScroll: true }));
  };
  const postGoal = async (
    projectId: string,
    title: string,
    objective: string,
    workspaceConfirmation?: { workspaceId: string; rootPath: string; version: string },
  ) => {
    await runAction('goal', async () => {
      const { task } = await api<{ task: Task }>(
        `/api/projects/${encodeURIComponent(projectId)}/goals`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(title.trim() ? { title: title.trim() } : {}),
            objective: objective.trim(),
            ...(workspaceConfirmation ? { workspaceConfirmation } : {}),
          }),
        },
      );
      goalDialogRef.current?.close();
      setBoundGoal(null);
      setSelectedTaskId(task.id);
      setGoalTitle('');
      setGoalObjective('');
      try {
        localStorage.removeItem(`draft:goal:${projectId}`);
      } catch {}
      if (goalComposerRef.current) goalComposerRef.current.open = false;
      setNotice(`「${task.title}」已开始，进度会自动更新。`);
    });
  };

  const submitGoal = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !boss || !startReady || !goalObjective.trim()) return;
    if (directoryBinding) {
      setError(null);
      setBoundGoalAccepted(false);
      setBoundGoal({
        projectId: project.id,
        title: goalTitle,
        objective: goalObjective,
        workspaceId: directoryBinding.id,
        rootPath: directoryBinding.rootPath,
        version: directoryBinding.confirmationVersion ?? '',
      });
      return;
    }
    await postGoal(project.id, goalTitle, goalObjective);
  };

  const saveDraft = async () => {
    if (!project || !goalObjective.trim()) return;
    await runAction('draft', async () => {
      const task = await api<Task>(`/api/projects/${encodeURIComponent(project.id)}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          objective: goalObjective.trim(),
          ...(goalTitle.trim() ? { title: goalTitle.trim() } : {}),
        }),
      });
      setSelectedTaskId(task.id);
      setGoalTitle('');
      setGoalObjective('');
      try {
        localStorage.removeItem(`draft:goal:${project.id}`);
      } catch {}
      setNotice('草稿已保存，尚未启动 Agent。');
    });
  };

  const decideApproval = async (approvalId: string, decision: 'approve' | 'reject') => {
    if (busyRef.current) throw new Error('另一项操作正在处理中。');
    busyRef.current = true;
    setBusy(`approval:${approvalId}`);
    setFailedAction(null);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ state: string }>(
        `/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      if (result.state !== (decision === 'approve' ? 'approved' : 'rejected'))
        throw new Error('服务端未确认此决定。');
      setNotice(decision === 'approve' ? '此审批已确认允许一次。' : '此审批已确认拒绝。');
      await loadSnapshot();
    } catch (reason) {
      setFailedAction(`approval:${approvalId}`);
      setError(
        reason instanceof HttpError
          ? `HTTP ${reason.status}：${reason.message}`
          : reason instanceof Error
            ? reason.message
            : '决定未确认。',
      );
      throw reason;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const registerAgent = async (event: FormEvent) => {
    event.preventDefault();
    await runAction('register', async () => {
      const encodeRegistration = (definition: Record<string, unknown>) =>
        JSON.stringify(selectedCatalog ? { entryId: selectedCatalog.id, definition } : definition);
      const capabilities = agentForm.capabilities
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((name) => ({ name, source: 'configured' }));
      const args = agentForm.args
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      const environmentAllowlist = agentForm.environmentAllowlist
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      await api(selectedCatalog ? '/api/agent-catalog/bind-local' : '/api/agents', {
        method: 'POST',
        body: encodeRegistration({
          id: agentForm.id.trim() || `agent-${crypto.randomUUID()}`,
          name: agentForm.name.trim(),
          enabled: true,
          runtime: {
            type: 'acp-stdio',
            command: agentForm.command.trim(),
            args,
            ...(agentForm.cwd.trim() ? { cwd: agentForm.cwd.trim() } : {}),
            ...(environmentAllowlist.length > 0 ? { environmentAllowlist } : {}),
          },
          capabilities,
          auth: { mode: 'agent-managed' },
          orchestration: { canBeBoss: agentForm.canBeBoss },
          controlBridge: agentForm.canBeBoss
            ? {
                transport: 'mcp',
                scopes: [
                  'boss.orchestration',
                  'agent.messaging',
                  'artifact.read',
                  'artifact.publish',
                  'task.status',
                ],
              }
            : {
                transport: 'mcp',
                scopes: ['agent.messaging', 'artifact.read', 'artifact.publish', 'task.status'],
              },
        }),
      });
      setAddingAgent(false);
      setAgentForm(emptyAgentForm);
      setSelectedCatalog(null);
      setNotice(
        selectedCatalog
          ? '本地入口已注册但未启用；未启动进程、登录或调用模型。目录版本不是本机版本。'
          : '成员已添加。下一步：点击该成员的「检查连接」，再选为负责人。',
      );
    });
  };

  const probe = (agentId: string) =>
    runAction(`probe:${agentId}`, async () => {
      await api(`/api/agents/${encodeURIComponent(agentId)}/probe`, { method: 'POST' });
      setNotice(`Probed ${agentId}.`);
    });

  const authenticate = (agentId: string, methodId: string) =>
    runAction(`auth:${agentId}`, async () => {
      await api(`/api/agents/${encodeURIComponent(agentId)}/auth`, {
        method: 'POST',
        body: JSON.stringify({ methodId }),
      });
      setNotice(`Authentication action completed for ${agentId}.`);
    });

  const selectBoss = (agentId: string) => {
    if (!project) {
      return Promise.resolve();
    }
    return runAction('boss', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}/boss`, {
        method: 'PUT',
        body: JSON.stringify({ agentId: agentId || null }),
      });
      setNotice(
        agentId
          ? `Selected ${agentId} as Boss for ${project.name}.`
          : '已取消项目默认 Boss；已有任务的 Boss 分派保持不变。',
      );
    });
  };

  const confirmTaskAction = async () => {
    const action = taskAction;
    if (
      !action ||
      (action.kind === 'resume' &&
        resumeBinding &&
        (!resumeBinding.confirmationVersion ||
          resumeDirectoryVersion !== resumeBinding.confirmationVersion))
    )
      return;
    await runAction(`task:${action.task.id}`, async () => {
      await api(`/api/tasks/${encodeURIComponent(action.task.id)}/${action.kind}`, {
        method: 'POST',
        body: JSON.stringify(
          action.kind === 'resume' && resumeBinding
            ? {
                workspaceConfirmation: {
                  workspaceId: resumeBinding.id,
                  rootPath: resumeBinding.rootPath,
                  version: resumeDirectoryVersion ?? '',
                },
              }
            : {},
        ),
      });
      taskDialogRef.current?.close();
      setTaskAction(null);
      setNotice(
        action.kind === 'cancel'
          ? 'Task cancellation saved. Records remain available.'
          : 'New execution attempt created from saved context.',
      );
    });
  };

  const family = activeTask
    ? taskFamily(tasks, activeTask.id)
    : new Set(tasks.map((task) => task.id));
  const scopedEvents = (snapshot?.timeline ?? []).filter(
    (event) => event.projectId === project?.id && (!event.taskId || family.has(event.taskId)),
  );
  const scopedMessages = (snapshot?.messages ?? []).filter((message) =>
    messageInTaskScope(message, project?.id, family),
  );
  const scopedApprovals = approvals.filter(
    (approval) => !activeTask || !approval.taskId || family.has(approval.taskId),
  );
  const eligibility =
    activeTask && snapshot ? taskActionEligibility(activeTask, snapshot) : undefined;
  const pendingApprovals = approvals.filter((approval) => approval.state === 'pending');

  const contextContent = (
    <>
      {narrow && error && failedAction?.startsWith('approval:') ? (
        <p className="error-card context-feedback" role="alert">
          {error}
        </p>
      ) : null}
      {narrow && notice ? (
        <p className="notice-card context-feedback" role="status" aria-label="Action result">
          {notice}
        </p>
      ) : null}
      <header className="context-heading">
        <h2>结果与审批</h2>
        {narrow ? (
          <button type="button" onClick={closeContext}>
            Close context
          </button>
        ) : null}
      </header>
      {selectedArtifact ? (
        <ArtifactPreview
          key={selectedArtifact.id}
          artifact={selectedArtifact}
          onClose={closeArtifact}
        />
      ) : (
        <div className="context-body">
          {activeTask ? (
            <section className="task-context-summary" aria-label="Selected task">
              <small>{activeTask.parentTaskId ? '子任务' : '目标'}</small>
              <h3>{activeTask.title}</h3>
              <Badge>{taskStateLabel(activeTask.state)}</Badge>
              <p>
                {agentLabel(snapshot ? taskAgentId(activeTask, snapshot) : undefined, snapshot)}
              </p>
              <TaskTechnicalDetails task={activeTask} snapshot={snapshot} />
              <div className="card-actions">
                {eligibility?.canResume ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setTaskAction({ kind: 'resume', task: activeTask })}
                  >
                    从已保存进度恢复
                  </button>
                ) : null}
                {eligibility?.canCancel ? (
                  <button
                    type="button"
                    className="reject-button"
                    disabled={busy !== null}
                    onClick={() => setTaskAction({ kind: 'cancel', task: activeTask })}
                  >
                    取消任务
                  </button>
                ) : null}
              </div>
              {activeTask.state === 'failed' || eligibility?.canResume ? (
                <p className="section-note">{eligibility?.reason}</p>
              ) : null}
              {activeTask.state === 'completed' || activeTask.state === 'cancelled' ? (
                <p className="section-note">任务已结束，执行记录与结果仍可查看。</p>
              ) : null}
            </section>
          ) : (
            <p className="empty">选择任务后查看进度、审批和结果。</p>
          )}
          {activeTask && snapshot ? (
            <TaskWorkspacePanel task={activeTask} snapshot={snapshot} />
          ) : null}
          <ApprovalPanel
            key={JSON.stringify([project?.id ?? null, activeTask?.id ?? null])}
            approvals={approvals}
            visibleIds={scopedApprovals.map((approval) => approval.id)}
            diagnostics={snapshot?.approvalReadDiagnostics}
            healthy={snapshot !== null && loadError === null}
            startedAt={snapshotStartedAt}
            busy={busy !== null}
            onRefresh={loadSnapshot}
            onDecision={decideApproval}
          />
          <section className="context-section" aria-label="Artifacts">
            <h2>项目产物</h2>
            <p className="section-note">这里保存项目中的文件和回复，任务结果也可从左侧任务打开。</p>
            <div className="stack">
              {artifacts.map((artifact) => (
                <article className="row-card" key={artifact.id}>
                  <div>
                    <strong>{artifact.id}</strong>
                    <small>
                      {artifact.producerAgentId ?? 'system'} · {artifact.sizeBytes} bytes
                    </small>
                    <Badge>{artifact.kind}</Badge>
                  </div>
                  <button
                    type="button"
                    data-result-trigger={`artifact:${artifact.id}`}
                    onClick={(event) => openArtifact(artifact.id, event.currentTarget)}
                  >
                    查看产物
                  </button>
                </article>
              ))}
              {artifacts.length === 0 ? <Empty>还没有产物，任务完成后会显示在这里。</Empty> : null}
            </div>
          </section>
        </div>
      )}
    </>
  );

  return (
    <div className="app-shell guided-shell">
      <a className="skip-link" href="#workspace-main">
        跳转到工作区
      </a>
      <aside className="project-rail" aria-label="Project and task navigation">
        <header className="rail-brand">
          协作工作台 <small>Multi-Agent Control Plane</small>
        </header>
        <label className="project-picker">
          当前项目
          <select
            value={project?.id ?? ''}
            disabled={!snapshot?.projects.length}
            onChange={(event) => {
              setSelectedProjectId(event.target.value);
              setSelectedTaskId('');
              setSelectedArtifactId(null);
              setContextOpen(false);
              setNotice(null);
              setError(null);
            }}
          >
            <option value="" disabled>
              还没有项目
            </option>
            {snapshot?.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button className="rail-new-project" type="button" onClick={() => setNewProjectOpen(true)}>
          ＋ 新建项目
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!project}
          onClick={() => {
            setSettingsOpen(false);
            requestAnimationFrame(() => {
              if (goalComposerRef.current) goalComposerRef.current.open = true;
              goalObjectiveRef.current?.focus();
              goalComposerRef.current?.scrollIntoView({ block: 'center' });
            });
          }}
        >
          ＋ 新任务
        </button>

        <div className="rail-tasks-heading">
          <h2>任务记录</h2>
          <span>{tasks.length}</span>
        </div>
        <nav className="task-nav" aria-label="Tasks">
          {tasks.map((task) => (
            <article
              className={`task-card ${task.parentTaskId ? 'is-subtask' : ''}`}
              data-selected={task.id === activeTask?.id}
              data-state={task.state}
              key={task.id}
            >
              <button
                className="task-choice"
                type="button"
                aria-label={`Open task ${task.title}`}
                aria-current={task.id === activeTask?.id ? 'page' : undefined}
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setSelectedArtifactId(null);
                  setSettingsOpen(false);
                }}
              >
                <strong>{task.title}</strong>
                <small>
                  {task.parentTaskId ? '子任务' : '目标'} ·{' '}
                  {agentLabel(snapshot ? taskAgentId(task, snapshot) : undefined, snapshot)}
                </small>
                <Badge>{taskStateLabel(task.state)}</Badge>
              </button>
              {task.resultArtifactRefs.length ? (
                <div className="card-actions">
                  {task.resultArtifactRefs.map((id, index) => (
                    <button
                      key={id}
                      type="button"
                      disabled={!artifacts.some((artifact) => artifact.id === id)}
                      data-result-trigger={`task:${task.id}:${id}`}
                      onClick={(event) => openArtifact(id, event.currentTarget)}
                    >
                      {task.resultArtifactRefs.length === 1 ? '查看结果' : `查看结果 ${index + 1}`}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
          {snapshot && tasks.length === 0 ? <Empty>任务会保存在这里。</Empty> : null}
        </nav>
        <button
          className="settings-toggle"
          type="button"
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((value) => !value)}
        >
          {settingsOpen ? '返回任务' : '成员与设置'}
        </button>
        <p className="rail-note">任务和结果保存在本机。</p>
      </aside>

      <main className="workspace-main" id="workspace-main">
        <header className="workspace-header">
          <div>
            <h1>{settingsOpen ? '设置' : (project?.name ?? '协作工作台')}</h1>
            <p>{settingsOpen ? '一次接入，持续协作' : '描述目标 · 跟进协作 · 收取结果'}</p>
          </div>
          <div className="workspace-header-actions">
            <div className="status" role="status">
              <span className="status-dot" aria-hidden="true" />
              {loadError
                ? '连接异常'
                : snapshot
                  ? eventsLive
                    ? '任务事件实时同步'
                    : '已连接 · 自动刷新'
                  : '连接中…'}
            </div>
            <button
              className="context-toggle"
              type="button"
              onClick={(event) => openContext(event.currentTarget)}
            >
              结果与审批{pendingApprovals.length ? ` · ${pendingApprovals.length}` : ''}
            </button>
          </div>
        </header>
        <div className="workspace-feedback">
          {loadError ? (
            <div className="error-card" role="alert">
              {loadError}
            </div>
          ) : null}
          {error && !taskAction && !(narrow && contextOpen) ? (
            <div className="error-card" role="alert">
              {error}
            </div>
          ) : null}
          {notice && !(narrow && contextOpen) ? (
            <div className="notice-card" role="status" aria-label="Action result">
              {notice}
            </div>
          ) : null}
        </div>
        {settingsOpen ? (
          <div className="settings-view">
            <nav className="settings-tabs" aria-label="设置分类">
              {(
                [
                  ['team', '协作成员'],
                  ['project', '项目设置'],
                  ['memory', '项目记忆'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={settingsTab === id ? 'page' : undefined}
                  onClick={() => setSettingsTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {settingsTab === 'project' ? (
              <>
                <h2>文件夹与项目规则</h2>
                <p className="section-note">
                  日常任务使用已保存的设置。只有需要更换工作方式时，才在这里修改。
                </p>
                {project && snapshot ? (
                  <WorkspaceModePanel
                    key={
                      project.id +
                      snapshot.workspaceConfigs?.find((item) => item.id === project.id)?.updatedAt
                    }
                    projectId={project.id}
                    snapshot={snapshot}
                    onSaved={loadSnapshot}
                  />
                ) : null}
                {project ? <ProjectPolicyPanel key={project.id} projectId={project.id} /> : null}
                {!project ? <p>请先创建项目。</p> : null}
              </>
            ) : settingsTab === 'memory' ? (
              <>
                <h2>项目记忆</h2>
                {project && snapshot ? (
                  <ProjectMemoryPanel
                    key={project.id}
                    projectId={project.id}
                    snapshot={snapshot}
                    onOpenArtifact={openArtifact}
                  />
                ) : null}
                {!project ? <p>请先创建项目。</p> : null}
              </>
            ) : (
              <>
                <div className="panel-heading">
                  <div>
                    <h2>你的协作团队</h2>
                    <p className="section-note">
                      添加成员 → 检查连接 → 选一位负责人。以后直接发起任务。
                    </p>
                  </div>
                  <button type="button" onClick={() => setAddingAgent((value) => !value)}>
                    {addingAgent ? '收起添加表单' : '＋ 添加成员'}
                  </button>
                </div>
                <div className="boss-controls compact-boss">
                  <label htmlFor="boss-agent">任务负责人</label>
                  <select
                    id="boss-agent"
                    aria-label="选择任务负责人"
                    value={project?.defaultBossAgentId ?? ''}
                    disabled={!project || busy !== null}
                    onChange={(event) => void selectBoss(event.target.value)}
                  >
                    <option value="">请选择负责人</option>
                    {bossCandidates.map((agent) => (
                      <option key={agent.definition.id} value={agent.definition.id}>
                        {agent.definition.name} ({agent.definition.id})
                      </option>
                    ))}
                  </select>
                  <small>
                    {boss
                      ? '负责拆解、分派和汇总'
                      : '从已接入成员中选择；没有候选时，先添加成员或开启其负责人资格。'}
                  </small>
                </div>

                <details className="catalog-disclosure">
                  <summary>查找其他支持的 Agent</summary>
                  <AgentCatalogPanel
                    onPrepare={(choice) => {
                      setAddingAgent(true);
                      setSelectedCatalog(choice);
                      setAgentForm((form) => ({
                        ...form,
                        id: form.id || choice.id,
                        name: form.name || choice.name,
                      }));
                      requestAnimationFrame(() => commandInput.current?.focus());
                    }}
                  />
                </details>
                {addingAgent || !snapshot?.agents.length ? (
                  <section className="panel span-2 setup-panel">
                    <div className="panel-heading">
                      <div>
                        <p className="kicker">接入成员</p>
                        <h2>添加已有的 AI 成员</h2>
                      </div>
                    </div>
                    {selectedCatalog ? (
                      <div className="catalog-binding" role="status">
                        绑定目录：{selectedCatalog.name} · 目录版本 {selectedCatalog.version}
                        （非本机版本）。保留手填草稿；目录不会填入命令、参数或环境。只注册本机已有入口，默认未启用。
                        <button type="button" onClick={() => setSelectedCatalog(null)}>
                          切回自定义入口（保留草稿）
                        </button>
                      </div>
                    ) : (
                      <p className="section-note">
                        填写你已安装的 ACP 适配器入口。桌面应用本身通常不能直接连接；例如 Node
                        适配器需填写 node.exe，并在参数中填适配器脚本路径。
                      </p>
                    )}
                    <form className="agent-form" onSubmit={(event) => void registerAgent(event)}>
                      <label>
                        成员名称
                        <input
                          required
                          value={agentForm.name}
                          onChange={(event) =>
                            setAgentForm({ ...agentForm, name: event.target.value })
                          }
                          placeholder="例如：我的 Codex"
                        />
                      </label>
                      <label className="span-form-2">
                        启动程序路径
                        <input
                          required
                          ref={commandInput}
                          value={agentForm.command}
                          onChange={(event) =>
                            setAgentForm({ ...agentForm, command: event.target.value })
                          }
                          placeholder="例如：D:\tools\agent.exe 或 node.exe 的完整路径"
                        />
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={agentForm.canBeBoss}
                          onChange={(event) =>
                            setAgentForm({ ...agentForm, canBeBoss: event.target.checked })
                          }
                        />
                        允许担任任务负责人（拆解、分派和汇总）
                      </label>
                      <label className="span-form-2">
                        启动参数（需要时填写，每行一个）
                        <textarea
                          rows={3}
                          value={agentForm.args}
                          onChange={(event) =>
                            setAgentForm({ ...agentForm, args: event.target.value })
                          }
                          placeholder="--acp\n--stdio"
                        />
                      </label>
                      <details className="span-form-2 registration-advanced">
                        <summary>高级接入参数（通常不需要修改）</summary>
                        <div className="agent-form">
                          {' '}
                          <label>
                            内部标识（自动生成）
                            <input
                              value={agentForm.id}
                              onChange={(event) =>
                                setAgentForm({ ...agentForm, id: event.target.value })
                              }
                              placeholder="codex-local"
                            />
                          </label>
                          <label>
                            启动目录
                            <input
                              value={agentForm.cwd}
                              onChange={(event) =>
                                setAgentForm({ ...agentForm, cwd: event.target.value })
                              }
                              placeholder="optional"
                            />
                          </label>
                          <label>
                            擅长的能力标签（逗号分隔）
                            <input
                              value={agentForm.capabilities}
                              onChange={(event) =>
                                setAgentForm({ ...agentForm, capabilities: event.target.value })
                              }
                              placeholder="code.read, code.write"
                            />
                          </label>
                          <label>
                            继承的环境变量名
                            <input
                              value={agentForm.environmentAllowlist}
                              onChange={(event) =>
                                setAgentForm({
                                  ...agentForm,
                                  environmentAllowlist: event.target.value,
                                })
                              }
                              placeholder="HOME, CUSTOM_AGENT_CONFIG"
                            />
                          </label>
                        </div>
                      </details>
                      <p className="section-note span-form-2">
                        添加即允许成员收发协作消息、读取授权产物及提交结果。勾选负责人资格后，还可分派任务。细项可在成员卡片中调整；不会自动批准执行中的危险操作。
                      </p>
                      <div className="form-actions span-form-2">
                        <button type="submit" disabled={busy !== null}>
                          {busy === 'register' ? '添加中…' : '添加成员'}
                        </button>
                        <small>添加只保存设置；下一步检查连接，登录由成员自身完成。</small>
                      </div>
                    </form>
                  </section>
                ) : null}
                <section className="panel span-2">
                  <div className="panel-heading">
                    <div>
                      <p className="kicker">已接入</p>
                      <h2>成员连接</h2>
                    </div>
                    <Badge>{String(snapshot?.agents.length ?? 0)}</Badge>
                  </div>
                  <div className="agent-grid">
                    {snapshot?.agents.map((agent) => (
                      <article className="agent-card" key={agent.definition.id}>
                        <div className="agent-title">
                          <div>
                            <strong>{agent.definition.name}</strong>
                            <small>{agent.definition.id}</small>
                          </div>
                          <Badge>
                            {agent.definition.orchestration.canBeBoss ? '配置可作 Boss' : 'Worker'}
                          </Badge>
                        </div>
                        <div className="agent-meta">
                          <span>Runtime: {agent.readiness.runtime}</span>
                          <span>Auth: {agent.readiness.auth}</span>
                        </div>
                        <AgentConnectionDetails agent={agent} />
                        <AgentBridgePanel agent={agent.definition} onSaved={loadSnapshot} />
                        <AgentRemovalPanel
                          agentId={agent.definition.id}
                          onRemoved={async () => {
                            setNotice(`已移除 ${agent.definition.name} 的注册项。`);
                            await loadSnapshot();
                          }}
                        />
                        {agent.error ? <p className="inline-error">{agent.error}</p> : null}
                        <div className="chips">
                          {agent.definition.capabilities.map((capability) => (
                            <span key={capability.name}>{capability.name}</span>
                          ))}
                        </div>

                        <div className="card-actions">
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction('enable:' + agent.definition.id, async () => {
                                await api(
                                  '/api/agents/' + encodeURIComponent(agent.definition.id),
                                  {
                                    method: 'PATCH',
                                    body: JSON.stringify({ enabled: !agent.definition.enabled }),
                                  },
                                );
                                setNotice('入口启用状态已更新；未提交任务或调用模型。');
                              })
                            }
                          >
                            {agent.definition.enabled ? '停用入口' : '启用入口'}
                          </button>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void probe(agent.definition.id)}
                          >
                            {busy === `probe:${agent.definition.id}` ? '检查中…' : '检查连接'}
                          </button>
                          {agent.authMethods
                            .filter((method) => method.type !== 'terminal')
                            .map((method) => (
                              <button
                                type="button"
                                key={method.id}
                                disabled={busy !== null}
                                onClick={() => void authenticate(agent.definition.id, method.id)}
                              >
                                {busy === `auth:${agent.definition.id}`
                                  ? '登录中…'
                                  : `登录：${method.name}`}
                              </button>
                            ))}
                        </div>
                        {agent.authMethods.some((method) => method.type === 'terminal') ? (
                          <small className="terminal-note">
                            Terminal authentication is advertised and must be completed
                            interactively outside this API.
                          </small>
                        ) : null}
                      </article>
                    ))}
                    {snapshot && snapshot.agents.length === 0 ? (
                      <Empty>还没有成员，使用上方表单添加。</Empty>
                    ) : null}
                  </div>
                </section>
                <details className="runtime-disclosure">
                  <summary>高级：运行环境与工作区诊断</summary>
                  <section className="panel span-2">
                    <div className="panel-heading">
                      <div>
                        <p className="kicker">Execution boundary</p>
                        <h2>Runner & workspace</h2>
                      </div>
                    </div>
                    <div className="boundary-grid">
                      {snapshot?.runners.map((runner) => (
                        <article className="boundary-card" key={runner.id}>
                          <strong>{runner.id}</strong>
                          <span>{runner.kind}</span>
                          <Badge>{runner.status}</Badge>
                        </article>
                      ))}
                      {snapshot?.workspaces
                        .filter((workspace) => workspace.projectId === project?.id)
                        .map((workspace) => (
                          <article className="boundary-card" key={workspace.id}>
                            <strong>{workspace.id}</strong>
                            <span>{workspace.provider}</span>
                            <Badge>{workspace.access}</Badge>
                            {snapshot?.workspaceCleanups?.some(
                              (item) => item.id === workspace.id,
                            ) ? (
                              <Badge>已进入清理流程</Badge>
                            ) : null}
                          </article>
                        ))}
                    </div>
                    <p className="security-note">
                      LocalRunner and Git worktrees are coordination boundaries, not OS security
                      sandboxes.
                    </p>
                  </section>
                </details>
              </>
            )}
          </div>
        ) : (
          <div className="workspace-content">
            {project && snapshot ? (
              <ProjectSetupPanel
                project={project}
                snapshot={snapshot}
                busy={busy !== null}
                onSettings={() => {
                  setSettingsTab(
                    snapshot.workspaceConfigs?.some(
                      (item) => item.id === project.id && item.mode === 'unconfigured',
                    )
                      ? 'project'
                      : 'team',
                  );
                  setSettingsOpen(true);
                }}
                onProbe={probe}
              />
            ) : null}
            {project ? (
              <>
                {' '}
                <details
                  ref={goalComposerRef}
                  className="new-goal"
                  open={tasks.length === 0 ? true : undefined}
                >
                  <summary>你想完成什么？</summary>
                  <p className="section-note">
                    写清你想得到什么，负责人会安排协作。开始后，进度和结果都会保存在这里。
                  </p>
                  <form className="goal-form" onSubmit={(event) => void submitGoal(event)}>
                    {directoryBinding ? (
                      <DirectoryExecutionNotice rootPath={directoryBinding.rootPath} />
                    ) : null}
                    <label htmlFor="goal-objective">描述任务</label>
                    <textarea
                      id="goal-objective"
                      ref={goalObjectiveRef}
                      required
                      rows={4}
                      maxLength={100_000}
                      value={goalObjective}
                      onChange={(event) => setGoalObjective(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          const form = event.currentTarget.form;
                          if (form) form.requestSubmit();
                        }
                      }}
                      placeholder="例如：帮我检查项目的登录流程，找出问题并给出修复建议，让另一位成员复核结果。（按 Ctrl+Enter 开始协作）"
                      disabled={busy === 'goal'}
                    />
                    <div className="example-prompts" aria-label="任务示例">
                      <span>试试：</span>
                      {[
                        [
                          '分析问题',
                          '请分析我描述的问题，提出可执行的解决方案，并请另一位成员检查方案中的遗漏。',
                        ],
                        [
                          '审查代码',
                          '请审查项目代码，找出影响最大的三个问题，安排另一位成员独立复核，最后给出修改建议。',
                        ],
                        [
                          '协作写方案',
                          '请根据以下需求写一份实现方案，安排另一位成员检查风险，汇总成最终方案。需求：',
                        ],
                      ].map(([label, text]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => {
                            setGoalObjective((prev) =>
                              prev.trim() ? `${prev.trim()}\n\n${text}` : text!,
                            );
                            goalObjectiveRef.current?.focus();
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <details className="composer-options">
                      <summary>给任务起个名字（选填）</summary>{' '}
                      <label htmlFor="goal-title">任务名称</label>
                      <input
                        id="goal-title"
                        value={goalTitle}
                        maxLength={256}
                        onChange={(event) => setGoalTitle(event.target.value)}
                        placeholder="例如：审查登录模块"
                        disabled={busy === 'goal'}
                      />
                    </details>
                    <div className="form-actions">
                      <button
                        type="button"
                        disabled={busy !== null || !project || !goalObjective.trim()}
                        onClick={() => void saveDraft()}
                      >
                        {busy === 'draft' ? '保存中…' : '保存草稿'}
                      </button>
                      <button
                        className="primary-button"
                        ref={goalSubmitRef}
                        type="submit"
                        title="支持按 Ctrl+Enter 快捷提交"
                        disabled={
                          busy !== null ||
                          !project ||
                          !bossCandidates.some(
                            (agent) => agent.definition.id === project.defaultBossAgentId,
                          ) ||
                          !goalObjective.trim() ||
                          !startReady
                        }
                      >
                        {busy === 'goal' ? '启动中…' : '开始协作 →'}
                      </button>
                      <small>
                        {!project
                          ? '请先创建项目。'
                          : !boss
                            ? '先设置协作成员，也可以保存草稿。'
                            : !startReady
                              ? '请先完成上方的连接或文件夹设置。'
                              : `由 ${boss.definition.name} 负责 · 开始后会调用模型`}
                      </small>
                    </div>
                  </form>
                </details>
              </>
            ) : (
              <section className="welcome-panel">
                <p className="kicker">你的本地 AI 协作空间</p>
                <h2>
                  把目标交给团队，
                  <br />
                  把决定留给你。
                </h2>
                <p>
                  一个成员负责拆解任务，其他成员协作完成。你在这里看进度、补充要求、确认关键操作，最后收取结果。
                </p>
                <ol className="welcome-steps">
                  <li>
                    <span>1</span>
                    <strong>建一个项目</strong>
                    <small>给任务和文件一个归属</small>
                  </li>
                  <li>
                    <span>2</span>
                    <strong>连接协作成员</strong>
                    <small>接入已有的 AI，只需设置一次</small>
                  </li>
                  <li>
                    <span>3</span>
                    <strong>说出你的目标</strong>
                    <small>跟进执行，查看最终结果</small>
                  </li>
                </ol>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!snapshot || busy !== null}
                  onClick={() => setNewProjectOpen(true)}
                >
                  创建第一个项目 →
                </button>
                <small className="welcome-footnote">创建项目和保存草稿不会调用模型。</small>
              </section>
            )}
            {pendingApprovals.length ? (
              <div className="attention-banner">
                <div>
                  <strong>{pendingApprovals.length} 项审批等待决定</strong>
                  <p>请先查看请求的操作与对象，再明确批准或拒绝。</p>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    setSelectedArtifactId(null);
                    const request = pendingApprovals[0];
                    if (request?.taskId && tasks.some((task) => task.id === request.taskId))
                      setSelectedTaskId(request.taskId);
                    openContext(event.currentTarget);
                  }}
                >
                  查看待审批事项
                </button>
              </div>
            ) : null}
            {activeTask ? (
              <section className="goal-overview">
                <small>{activeTask.parentTaskId ? '子任务' : '目标'}</small>
                <div className="goal-title">
                  <h2>{activeTask.title}</h2>
                  <Badge>{taskStateLabel(activeTask.state)}</Badge>
                </div>
                <p>{activeTask.objective}</p>
                <TaskRecordPanel
                  key={activeTask.id}
                  task={activeTask}
                  boss={boss ? { id: boss.definition.id, name: boss.definition.name } : undefined}
                  directory={
                    directoryBinding
                      ? {
                          workspaceId: directoryBinding.id,
                          rootPath: directoryBinding.rootPath,
                          version: directoryBinding.confirmationVersion ?? '',
                        }
                      : undefined
                  }
                  onSaved={loadSnapshot}
                  onDeleted={() => {
                    setSelectedTaskId('');
                    setNotice('草稿已删除。');
                  }}
                />
                <small>
                  执行者：
                  {agentLabel(
                    snapshot ? taskAgentId(activeTask, snapshot) : undefined,
                    snapshot,
                  )} · {family.size - 1} 个子任务
                </small>
                <TaskTechnicalDetails task={activeTask} snapshot={snapshot} />
              </section>
            ) : null}
            {activeTask && snapshot ? (
              <CollaborationProgress
                task={activeTask}
                snapshot={snapshot}
                onSelectTask={setSelectedTaskId}
                onOpenArtifact={openArtifact}
              />
            ) : null}
            {activeTask && snapshot ? (
              <WorkspaceReviewPanel
                key={activeTask.id}
                task={activeTask}
                snapshot={snapshot}
                onOpenArtifact={openArtifact}
                onSaved={loadSnapshot}
              />
            ) : null}
            {activeTask ? (
              <TaskInstructionPanel
                key={activeTask.projectId + ':' + activeTask.id}
                taskId={activeTask.id}
              />
            ) : null}
            {activeTask &&
            snapshot?.assignmentWorkspaces?.some((item) => item.taskId === activeTask.id) ? (
              <WorkspaceCleanupPanel
                key={'cleanup-' + activeTask.id}
                taskId={activeTask.id}
                onSaved={loadSnapshot}
              />
            ) : null}
            {activeTask ? (
              <ExecutionContextPanel
                events={scopedEvents}
                taskId={activeTask.id}
                onOpenArtifact={openArtifact}
              />
            ) : null}
            {activeTask ? (
              <>
                <MessagePanel
                  key={'messages-' + activeTask?.id}
                  onSelectTask={setSelectedTaskId}
                  messages={scopedMessages}
                  snapshot={snapshot}
                  onOpenArtifact={openArtifact}
                />
                <details className="execution-history">
                  <summary>执行记录（{scopedEvents.length}）</summary>
                  <ExecutionTimeline events={scopedEvents} snapshot={snapshot} />
                </details>
              </>
            ) : null}
          </div>
        )}
      </main>
      {narrow ? (
        <dialog
          className="context-dialog"
          ref={contextDialogRef}
          onClose={() => {
            setContextOpen(false);
            if (selectedArtifactId) setSelectedArtifactId(null);
          }}
          onCancel={() => setContextOpen(false)}
        >
          {contextContent}
        </dialog>
      ) : (
        <aside className="context-dock" aria-label="结果与审批">
          {contextContent}
        </aside>
      )}
      <dialog
        ref={projectDialog}
        className="task-action-dialog project-create-dialog"
        onClose={() => setNewProjectOpen(false)}
        onCancel={() => setNewProjectOpen(false)}
      >
        <div className="panel-heading">
          <div>
            <p className="kicker">第一步 · 项目</p>
            <h2>给这次工作起个名字</h2>
          </div>
          <button type="button" onClick={() => setNewProjectOpen(false)}>
            关闭
          </button>
        </div>
        <p className="section-note">
          项目会保存你的任务、结果和协作记录。先用空文件夹即可开始，也可以关联已有代码。
        </p>
        <form
          className="project-form guided-project-form"
          onSubmit={(event) => void createProject(event)}
        >
          <label>
            项目名称
            <input
              required
              maxLength={256}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="例如：我的网站、产品调研"
              disabled={busy === 'project'}
            />
          </label>
          <ExistingDirectoryInput
            key={directoryFormKey}
            disabled={busy !== null}
            onChoice={setProjectDirectory}
          />
          <button
            type="submit"
            disabled={busy !== null || !projectName.trim() || projectDirectory.kind === 'pending'}
          >
            {busy === 'project' ? '创建中…' : '创建项目'}
          </button>
        </form>
        {error && failedAction === 'project' ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
      </dialog>
      <dialog
        ref={goalDialogRef}
        className="task-action-dialog"
        onClose={() => setBoundGoal(null)}
        onCancel={closeGoalConfirmation}
      >
        {boundGoal ? (
          <>
            <h2>确认在已有目录执行</h2>
            <DirectoryExecutionNotice rootPath={boundGoal.rootPath} />
            <p>{boundGoal.title || boundGoal.objective}</p>
            <label className="directory-check">
              <input
                type="checkbox"
                checked={boundGoalAccepted}
                onChange={(event) => setBoundGoalAccepted(event.target.checked)}
              />
              我了解本次任务可能读取或修改此目录
            </label>
            {error ? (
              <p role="alert" className="inline-error">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" disabled={busy !== null} onClick={closeGoalConfirmation}>
                暂不执行
              </button>
              <button
                type="button"
                disabled={
                  busy !== null ||
                  !boundGoalAccepted ||
                  !boundGoal.version ||
                  boundGoal.projectId !== project?.id
                }
                onClick={() =>
                  void postGoal(boundGoal.projectId, boundGoal.title, boundGoal.objective, {
                    workspaceId: boundGoal.workspaceId,
                    rootPath: boundGoal.rootPath,
                    version: boundGoal.version,
                  })
                }
              >
                确认并开始协作
              </button>
            </div>
          </>
        ) : null}
      </dialog>
      <dialog
        ref={taskDialogRef}
        className="task-action-dialog"
        onClose={() => setTaskAction(null)}
        onCancel={() => setTaskAction(null)}
      >
        {taskAction ? (
          <>
            <h2>{taskAction.kind === 'cancel' ? 'Cancel this task?' : '从已保存进度恢复?'}</h2>
            <p>
              <strong>{taskAction.task.title}</strong>
            </p>
            <p>
              {taskAction.kind === 'cancel'
                ? `Stops this task and its ${taskFamily(tasks, taskAction.task.id).size - 1} descendant tasks. Saved records remain; no automatic retry.`
                : 'Creates a new execution attempt using saved context. This is not a file rollback and does not guarantee continuation of the original ACP session.'}
            </p>
            {taskAction.kind === 'resume' && resumeBinding ? (
              <>
                <DirectoryExecutionNotice rootPath={resumeBinding.rootPath} />
                <label className="directory-check">
                  <input
                    type="checkbox"
                    checked={
                      Boolean(resumeBinding.confirmationVersion) &&
                      resumeDirectoryVersion === resumeBinding.confirmationVersion
                    }
                    onChange={(event) =>
                      setResumeDirectoryVersion(
                        event.target.checked ? (resumeBinding.confirmationVersion ?? null) : null,
                      )
                    }
                  />
                  I have rechecked this workspace before recovery
                </label>
              </>
            ) : null}
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => taskDialogRef.current?.close()}
              >
                Back
              </button>
              <button
                type="button"
                disabled={
                  busy !== null ||
                  (taskAction.kind === 'resume' &&
                    Boolean(resumeBinding) &&
                    (!resumeBinding?.confirmationVersion ||
                      resumeDirectoryVersion !== resumeBinding.confirmationVersion))
                }
                onClick={() => void confirmTaskAction()}
              >
                {busy === `task:${taskAction.task.id}`
                  ? 'Saving…'
                  : taskAction.kind === 'cancel'
                    ? 'Confirm cancellation'
                    : 'Create new execution attempt'}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
      <ToastContainer />
    </div>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
