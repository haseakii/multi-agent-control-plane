import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { getDefaultStore, Provider } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { DEFAULT_THEME_CONFIG, applyPlatformToDOM, applyThemeToDOM } from '@hermes/shared-ui';
import { AttachmentComposer } from './attachment-composer';
import { sameAttachmentIds, type InputAttachmentData } from './input-attachments';
import { LiveExecutionCard } from './live-execution-card';
import { MessageTimeline } from '@/components/chat/message-timeline';
import { SubagentPanel } from '@/components/chat/subagent-panel';
import { PanelHero } from '@/components/panel/panel-hero';
import { assistantDisplayNameAtom } from '@/stores/ui';
import { ConfirmProvider } from '@/lib/use-confirm';
import { ErrorBoundary } from '@/components/error-boundary';
import { initUiStore } from '@/lib/ui-store';
import { fetchJSON } from '@/lib/transport';
import {
  Plus,
  ArrowLeft,
  Users,
  FileText,
  RefreshCw,
  Sun,
  Moon,
  ListChecks,
  Pencil,
  Eye,
  GitPullRequest,
  PanelLeft,
  Settings2,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import {
  artifactUrl,
  cancelTask,
  canResumeTask,
  conversationRounds,
  conversationList,
  conversationMessages,
  decideApproval,
  eligibleAgents,
  readArtifact,
  readSnapshot,
  readConversationSnapshot,
  readWorkbench,
  readInstructions,
  readChatReceipt,
  sendChat,
  type InstructionData,
  type WorkbenchData,
  resumeTask,
  startTask,
  stateLabel,
  taskFamily,
  taskAgentName,
  terminal,
  toSubagents,
  type SnapshotData,
  type Submission,
} from './adapter';
import { memberUnavailableReason, type ExecutionMode } from './agent-selection';
import { MemberSelectionHelp } from './member-selection-help';
import { activeAgents } from './agent-config';
import { MemberActivity, recentMemberTask } from './member-history';
import { MemberWorkHint } from './member-work-hint';
import { WorkbenchHelp } from './workbench-help';
import { SystemSettings } from './system-settings';
import { ExternalClients } from './external-clients';
import { composerDrafts } from './composer-drafts';
import { followUpSubmissions } from './followup-submissions';
import { goalSubmissions } from './goal-submissions';
import { readWorkspaceDraft, saveWorkspaceDraft } from './workspace-draft';
import {
  filterConversations,
  scopeConversations,
  conversationProjects,
  needsAttention,
  type ConversationFilter,
} from './conversation-search';
import {
  readExecutionPreferences,
  writeExecutionPreferences,
  fillInitialMember,
  chooseMember,
  chooseExecutionMode,
  type ExecutionPreferences,
} from './execution-preferences';
import '@/styles/global.css';
import s from './workbench.module.css';
import { AgentConnections } from './agent-connections';
import { ComposerRuntimeSettings, TaskRuntimeSettings } from './agent-session-settings';
import {
  canApplyNextSessionSettings,
  sameSessionValues,
  type SessionSettingValuesData,
} from './session-setting-values';
import { readTaskExecutionActive } from './session-settings';
import { conversationControlKeys } from './conversation-control-keys';
import { AgentPermissions } from './agent-permissions';
import { ExecutionDetails } from './execution-details';
import { TaskFeedback } from './task-feedback';
import { ApprovalCard, ApprovalDialog } from './approval-card';
import { PermissionNotice } from './permission-notice';
import { workbenchError } from './workbench-error';
import { WorkspaceReviewPanel } from './workspace-review';
import { WorkspaceFileContext } from './workspace-file-context';
import { parseWorkspaceFileHref, type FileFocus, type FileScope } from './workspace-file-links';
import { WorkspacePicker, useWorkspaceConfirmation } from './workspace-picker';
import { pendingTaskApprovals } from './conversation-scope';
import { ArtifactPreviewLoader } from './artifact-previews';
import { SnapshotRefresh } from './snapshot-refresh';
import { PagePreview } from './page-preview';
import { resolveWorkspaceProject, type WorkspaceSelection } from './workspace-api';
declare const __HERMES_BUILD_ID__: string;

const ConversationRecord = z.object({
  task: z.object({ id: z.string(), title: z.string() }),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
type InstructionRead = {
  key: string;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

function RenameConversation({
  taskId,
  onClose,
  onSaved,
}: {
  taskId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [record, setRecord] = useState<z.infer<typeof ConversationRecord>>();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const saving = useRef(false);
  const readRecord = () =>
    fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/record`, undefined, ConversationRecord);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    void readRecord()
      .then((next) => {
        if (active) {
          setRecord(next);
          setTitle(next.task.title);
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [taskId, reload]);
  const save = async () => {
    if (!record || busy || saving.current || !title.trim()) return;
    if (title.trim() === record.task.title) {
      onClose();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await fetchJSON(
        `/api/tasks/${encodeURIComponent(taskId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ version: record.version, title: title.trim() }),
        },
        ConversationRecord,
      );
      await onSaved();
      onClose();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (/^HTTP 409\b/.test(message)) {
        try {
          setRecord(await readRecord());
          setError('会话已更新，已读取最新版本。请核对当前名称，再次保存。');
        } catch {
          setError('会话已更新，暂时无法读取最新版本。请稍后重试，输入的名称已保留。');
        }
      } else {
        setError(message);
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className={s.renameForm}
      aria-label="重命名会话"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        会话名称
        <input
          autoFocus
          value={title}
          maxLength={256}
          disabled={busy || !record}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) onClose();
          }}
        />
      </label>
      {error && (
        <p role="alert">
          {error}
          {record && <small>当前名称：{record.task.title}</small>}
        </p>
      )}
      <div>
        {!record && !busy ? (
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            重新读取
          </button>
        ) : (
          <button type="submit" disabled={busy || !title.trim()}>
            {busy ? '处理中…' : '保存'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
      </div>
    </form>
  );
}

function FollowUpComposer({
  conversationId,
  busy,
  paused,
  sending,
  resumeAvailable,
  queuedCount,
  claimedCount,
  onSend,
}: {
  conversationId: string;
  busy: boolean;
  paused: boolean;
  sending: boolean;
  resumeAvailable: boolean;
  queuedCount: number;
  claimedCount: number;
  onSend: (input: { text: string; attachments: unknown[] }) => Promise<void>;
}) {
  const key = `hermes-followup-${conversationId}`;
  const draft = useComposerDraft(key);
  return (
    <div className={s.followUp}>
      <AttachmentComposer
        key={key}
        attachmentKey={key}
        plainTextOnly
        variant="default"
        headerLabel={busy || paused ? '补充要求' : '继续追问'}
        placeholder={
          paused
            ? '补充要求，恢复任务后处理…'
            : busy
              ? '补充要求，执行成员会在当前步骤结束后处理…'
              : '继续提问或提出修改要求…'
        }
        initial={draft.initial}
        onDraftChange={draft.save}
        onSend={onSend}
        loading={sending}
        showMeta={false}
        showCompressCommand={false}
      />
      <DraftStorageNotice persisted={draft.persisted} />
      {followUpSubmissions.read(conversationId) && (
        <p className={s.instructionReceipt} role="status">
          上次发送尚未确认。再次发送相同文字，会先核对已保存的回执，避免重复执行。
        </p>
      )}
      {(queuedCount > 0 || claimedCount > 0) && (
        <p className={s.instructionReceipt} role="status">
          {queuedCount > 0 && `已保存 ${queuedCount} 条补充，等待交给执行成员。`}
          {claimedCount > 0 && `正在向执行成员发送 ${claimedCount} 条补充。`}
        </p>
      )}
      {(paused || resumeAvailable) && (
        <small>
          {paused
            ? '任务尚未恢复。补充会保存下来，请查看执行过程并恢复任务。'
            : busy
              ? '补充会保存在当前会话中，不会打断正在执行的步骤。'
              : resumeAvailable
                ? '继续原目标可点“保留改动并重试”；在这里发送新要求，会带上此前目标和结果开始下一轮。'
                : '自动带上此前目标和结果，无需重新说明背景。'}
        </small>
      )}
    </div>
  );
}

function useComposerDraft(key: string, fallback = '') {
  // The initial value stays stable while the composer owns live edits.
  const [seed] = useState(() => {
    const value = composerDrafts.read(key);
    return { ...value, text: value.text ?? fallback };
  });
  const [persisted, setPersisted] = useState(seed.persisted);
  const save = useCallback(
    (text: string) => {
      setPersisted(composerDrafts.write(key, text).persisted);
    },
    [key],
  );
  return { initial: seed.text, save, persisted };
}

function DraftStorageNotice({ persisted }: { persisted: boolean }) {
  return persisted ? null : (
    <p role="status" className={s.instructionReceipt}>
      浏览器暂时无法保存草稿。文字仍保留在当前页面，可以正常发送；刷新或关闭前请先复制。
    </p>
  );
}

function GoalComposer({
  initialAttachments,
  storageKey,
  initial,
  editing,
  sending,
  onSend,
}: {
  initialAttachments?: InputAttachmentData[];
  storageKey: string;
  initial: string;
  editing: boolean;
  sending: boolean;
  onSend: (input: { text: string; attachments: unknown[] }) => Promise<void>;
}) {
  // Keep the upstream initial prop stable while polling. Live text stays composer-owned.
  const draft = useComposerDraft(storageKey, initial);
  return (
    <>
      <AttachmentComposer
        key={storageKey}
        attachmentKey={storageKey}
        initialAttachments={initialAttachments}
        plainTextOnly
        variant="big"
        headerLabel={editing ? '继续编辑目标' : '这次想完成什么？'}
        placeholder="例如：请检查这个项目，并完成一个可以预览的小页面。"
        initial={draft.initial}
        onDraftChange={draft.save}
        onSend={onSend}
        loading={sending}
        showMeta={false}
        showCompressCommand={false}
        hints={[{ label: '输入目标' }, { label: '选择成员' }, { label: '发送后查看过程' }]}
      />
      <DraftStorageNotice persisted={draft.persisted} />
    </>
  );
}

function Workbench() {
  const [workbench, setWorkbench] = useState<WorkbenchData>();
  const [snapshot, setSnapshot] = useState<SnapshotData>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [activeId, setActiveId] = useState(() => new URLSearchParams(location.search).get('task'));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<ConversationFilter>('all');
  const [taskProject, setTaskProject] = useState('');
  const selectedTaskButton = useRef<HTMLButtonElement>(null);
  const [locateCurrent, setLocateCurrent] = useState(0);
  useEffect(() => {
    if (locateCurrent) {
      selectedTaskButton.current?.scrollIntoView({ block: 'nearest' });
      selectedTaskButton.current?.focus({ preventScroll: true });
    }
  }, [locateCurrent]);
  const [executionPreferences, setExecutionPreferences] = useState(readExecutionPreferences);
  const preferencesRef = useRef(executionPreferences);
  const executionMode = executionPreferences.mode;
  const bossId = executionPreferences.members[executionMode];
  const changePreferences = useCallback((next: ExecutionPreferences) => {
    preferencesRef.current = next;
    setExecutionPreferences(next);
    writeExecutionPreferences(next);
  }, []);
  const [sending, setSending] = useState(false);
  const [runtimeOverrides, setRuntimeOverrides] = useState<
    Record<string, SessionSettingValuesData | undefined>
  >({});
  const [submissionPersisted, setSubmissionPersisted] = useState(true);
  const [content, setContent] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState<InstructionData[]>([]);
  const [instructionError, setInstructionError] = useState('');
  const instructionScope = useRef<string | null>(null);
  const instructionRead = useRef<InstructionRead | null>(null);
  const [rail, setRail] = useState<'agents' | 'results' | 'process' | 'files' | 'preview' | null>(
    null,
  );
  const [approvalTarget, setApprovalTarget] = useState<string>();
  const [previewOpened, setPreviewOpened] = useState(false);
  const [fileFocus, setFileFocus] = useState<FileFocus | null>(null);
  const [reviewFocus, setReviewFocus] = useState<{ taskId: string }>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!reading) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setReading(false);
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [reading]);
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceSelection>(readWorkspaceDraft);
  useEffect(() => {
    saveWorkspaceDraft(workspaceChoice);
  }, [workspaceChoice]);
  const { confirmForProject, confirmationDialog } = useWorkspaceConfirmation();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [externalClientsOpen, setExternalClientsOpen] = useState(false);
  const [networkVersion, setNetworkVersion] = useState(0);
  const [networkMemberId, setNetworkMemberId] = useState<string>();
  const [connectionTarget, setConnectionTarget] = useState<string>();
  const [connectionAdd, setConnectionAdd] = useState(false);
  function openConnections(memberId?: string, add = false) {
    setConnectionTarget(memberId);
    setConnectionAdd(add);
    setConnectionsOpen(true);
  }
  const [draft, setDraft] = useState(() => composerDrafts.read('control-plane-draft').text ?? '');
  const [nonce, setNonce] = useState(0);
  const [dark, setDark] = useState(false);
  const submission = useRef<Submission | undefined>(undefined);
  const previewLoader = useRef<ArtifactPreviewLoader | null>(null);
  if (!previewLoader.current)
    previewLoader.current = new ArtifactPreviewLoader(readArtifact, (next) => {
      setContent(next.content);
      setPreviewErrors(next.errors);
    });
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const synchronizeInstructions = useCallback(
    (data: SnapshotData | undefined, selection: string | null) => {
      const task = data?.tasks.find((item) => item.id === selection);
      const rounds = task && data ? conversationRounds(data, task.id) : [];
      const scope = rounds[0]?.id ?? null;
      const key = JSON.stringify(rounds.map((round) => round.id));
      const previous = instructionRead.current;
      if (instructionScope.current !== scope) {
        instructionScope.current = scope;
        setInstructions([]);
        setInstructionError('');
      } else if (previous?.key === key) {
        return;
      }
      if (previous) {
        instructionRead.current = null;
        clearTimeout(previous.timer);
        previous.controller.abort();
      }
      if (!scope) return;
      const request: InstructionRead = {
        key,
        controller: new AbortController(),
      };
      instructionRead.current = request;
      request.timer = setTimeout(() => {
        if (instructionRead.current !== request) return;
        instructionRead.current = null;
        setInstructionError('补充记录读取超时，已显示的记录仍保留，稍后会重新读取。');
        request.controller.abort();
      }, 15_000);
      // Read history independently: saved-send acknowledgement and status polling never await it.
      void Promise.all(rounds.map((round) => readInstructions(round.id, request.controller.signal)))
        .then((lists) => {
          if (instructionRead.current !== request) return;
          setInstructions(lists.flatMap((list) => list.instructions));
          setInstructionError('');
        })
        .catch(() => {
          if (instructionRead.current === request)
            setInstructionError('暂时无法更新补充记录，已显示的记录仍保留，稍后会重新读取。');
        })
        .finally(() => {
          clearTimeout(request.timer);
          if (instructionRead.current === request) instructionRead.current = null;
          request.controller.abort();
        });
    },
    [],
  );
  const synchronizePreviews = useCallback((data: SnapshotData, selection: string | null) => {
    const root = data.tasks.find((task) => task.id === selection);
    if (!root) {
      previewLoader.current!.synchronize(null, []);
      return;
    }
    const rounds = conversationRounds(data, root.id);
    const ids = new Set(
      rounds.flatMap((round) => taskFamily(data, round)).flatMap((task) => task.resultArtifactRefs),
    );
    const familyIds = new Set(rounds.flatMap((round) => taskFamily(data, round)).map((t) => t.id));
    const sources = data.artifacts.filter(
      (artifact) =>
        (ids.has(artifact.id) ||
          (artifact.mimeType === 'text/html' &&
            artifact.taskId &&
            familyIds.has(artifact.taskId))) &&
        (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json'),
    );
    previewLoader.current!.synchronize(rounds[0]?.id ?? root.id, sources);
  }, []);
  const snapshotRefresh = useRef<SnapshotRefresh<[SnapshotData, WorkbenchData]> | null>(null);
  const refresh = useCallback(async () => {
    await snapshotRefresh.current?.refresh(true);
  }, []);
  useEffect(() => {
    const reader = new SnapshotRefresh<[SnapshotData, WorkbenchData]>(
      (signal) =>
        Promise.all([readConversationSnapshot(activeRef.current, signal), readWorkbench(signal)]),
      ([data, info]) => {
        // Synchronous bookkeeping only: requests run independently, never await previews here.
        // Invalidate old scope/hash tokens before presenting this newer snapshot.
        synchronizePreviews(data, activeRef.current);
        synchronizeInstructions(data, activeRef.current);
        setSnapshot(data);
        setWorkbench(info);
        setError('');
        const current = preferencesRef.current;
        const next = fillInitialMember(
          current,
          eligibleAgents(data, current.mode).map((a) => a.definition.id),
        );
        if (next !== current) changePreferences(next);
      },
      (error) => setError(workbenchError(error)),
    );
    snapshotRefresh.current = reader;
    void reader.refresh();
    const timer = setInterval(() => void reader.refresh(), 750);
    return () => {
      reader.dispose();
      if (snapshotRefresh.current === reader) snapshotRefresh.current = null;
      clearInterval(timer);
      previewLoader.current?.dispose();
      const request = instructionRead.current;
      instructionRead.current = null;
      clearTimeout(request?.timer);
      request?.controller.abort();
    };
  }, [synchronizePreviews, synchronizeInstructions, changePreferences]);
  const select = (id: string | null) => {
    setFileFocus(null);
    setReviewFocus(undefined);
    if (id !== activeRef.current) {
      submission.current = undefined;
      setActionError('');
    }
    if (id === null) setDraft(composerDrafts.read('control-plane-draft').text ?? '');
    // Navigation invalidates old callbacks immediately, before React commits a new view.
    if (snapshot) synchronizePreviews(snapshot, id);
    else previewLoader.current!.synchronize(null, []);
    synchronizeInstructions(snapshot, id);
    setActiveId(id);
    activeRef.current = id;
    history.replaceState(null, '', id ? `/?task=${encodeURIComponent(id)}` : '/');
    void refresh();
  };
  const rounds = snapshot && activeId ? conversationRounds(snapshot, activeId) : [];
  const root = rounds.at(-1);
  const editingDraft =
    root?.state === 'draft' &&
    !root.parentTaskId &&
    !snapshot?.assignments.some((assignment) => assignment.taskId === root.id)
      ? root
      : undefined;
  const goalDraftKey = editingDraft ? `hermes-goal-${editingDraft.id}` : 'control-plane-draft';
  const goalWorkspace: WorkspaceSelection = editingDraft
    ? { kind: 'saved-project', projectId: editingDraft.projectId }
    : workspaceChoice;
  const conversation = rounds[0];
  const controlKeys =
    root && conversation ? conversationControlKeys(root.id, conversation.id) : undefined;
  const goalSettingsKey = `${goalDraftKey}:${bossId}:${JSON.stringify(goalWorkspace)}`;
  const savedGoalSettings = goalSubmissions.read(goalDraftKey, goalWorkspace);
  const goalSettings = Object.prototype.hasOwnProperty.call(runtimeOverrides, goalSettingsKey)
    ? runtimeOverrides[goalSettingsKey]
    : savedGoalSettings?.settingsAgentId === bossId
      ? savedGoalSettings.sessionSettings
      : undefined;
  const followSettingsKey = conversation ? `follow:${conversation.id}` : '';
  const followSettings = Object.prototype.hasOwnProperty.call(runtimeOverrides, followSettingsKey)
    ? runtimeOverrides[followSettingsKey]
    : conversation
      ? followUpSubmissions.read(conversation.id)?.sessionSettings
      : undefined;
  const currentAgentId =
    root?.ownerAgentId ??
    snapshot?.assignments
      .filter((assignment) => assignment.taskId === root?.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.agentId;
  const currentAgentName =
    snapshot?.agents.find((agent) => agent.definition.id === currentAgentId)?.definition.name ??
    currentAgentId;
  const currentProject = snapshot?.projects.find((project) => project.id === root?.projectId);
  const roots = snapshot ? conversationList(snapshot) : [];
  const indexedConversations = roots.map((task) => {
    const history = conversationRounds(snapshot!, task.id);
    const familyIds = new Set(
      history.flatMap((round) => taskFamily(snapshot!, round)).map((item) => item.id),
    );
    const pending = snapshot!.approvals.filter(
      (approval) =>
        approval.state === 'pending' &&
        approval.projectId === task.projectId &&
        approval.taskId &&
        familyIds.has(approval.taskId),
    );
    const members = snapshot!.assignments
      .filter((item) => familyIds.has(item.taskId))
      .map(
        (item) =>
          snapshot!.agents.find((agent) => agent.definition.id === item.agentId)?.definition.name ??
          item.agentId,
      );
    return {
      ...task,
      searchText: [
        task.id,
        snapshot!.projects.find((project) => project.id === task.projectId)?.name ?? '',
        ...history.flatMap((round) => [round.title, round.objective]),
        ...members,
      ].join('\n'),
      pendingReview: pending.some((approval) => approval.action === 'git.merge'),
      pendingApproval: pending.some((approval) => approval.action !== 'git.merge'),
    };
  });
  const historyProjects = conversationProjects(indexedConversations, snapshot?.projects ?? []);
  const scopedConversations = scopeConversations(indexedConversations, taskProject);
  const visibleConversations = filterConversations(scopedConversations, taskSearch, taskFilter);
  const attentionCount = scopedConversations.filter(needsAttention).length;
  const clearTaskFilter = () => {
    setTaskSearch('');
    setTaskFilter('all');
    setTaskProject('');
  };
  const family = snapshot ? rounds.flatMap((r) => taskFamily(snapshot, r)) : [];
  const fileScopeKey = JSON.stringify(
    (snapshot?.assignmentWorkspaces ?? []).flatMap((binding) => {
      const workspace = snapshot?.workspaces.find((item) => item.id === binding.workspaceId);
      return binding.mode === 'git-worktree' &&
        workspace &&
        family.some((task) => task.id === binding.taskId)
        ? [{ taskId: binding.taskId, rootPath: workspace.rootPath }]
        : [];
    }),
  );
  const fileScopes = useMemo(() => JSON.parse(fileScopeKey) as FileScope[], [fileScopeKey]);
  const recoverable = !!root && !!snapshot && canResumeTask(snapshot, root);
  const busy =
    !!root &&
    !recoverable &&
    !terminal(root) &&
    !['draft', 'created', 'blocked'].includes(root.state);
  const leader = snapshot && root ? taskAgentName(snapshot, root) : undefined;
  const bosses = snapshot ? eligibleAgents(snapshot, executionMode) : [];
  const selectedMemberReady = bosses.some((a) => a.definition.id === bossId);
  const selectedMemberName =
    snapshot?.agents.find((a) => a.definition.id === bossId)?.definition.name ?? '此前选择的成员';
  const activeMemberIds = new Set(snapshot ? activeAgents(snapshot) : []);
  const selectedMemberTask = useMemo(() => {
    const parsed = MemberActivity.safeParse(snapshot);
    return parsed.success ? recentMemberTask(parsed.data, bossId, true) : undefined;
  }, [snapshot, bossId]);
  const selectedMemberIssue = memberUnavailableReason(
    snapshot?.agents.find((a) => a.definition.id === bossId),
    executionMode,
  );
  const real = workbench?.mode === 'real';
  const subagents = root && snapshot ? toSubagents(snapshot, root, content) : [];
  const allSubagents = snapshot ? rounds.flatMap((r) => toSubagents(snapshot, r, content)) : [];
  const artifacts =
    snapshot?.artifacts.filter((a) =>
      family.some(
        (t) =>
          t.resultArtifactRefs.includes(a.id) || (a.taskId === t.id && a.mimeType === 'text/html'),
      ),
    ) ?? [];
  const failedPreviews = artifacts.filter((artifact) => previewErrors[artifact.id] !== undefined);
  const retryPreview = (id: string) => {
    previewLoader.current?.retry(id);
  };
  const approvals = pendingTaskApprovals(snapshot?.approvals ?? [], snapshot?.tasks ?? [], root);
  const executionApprovals = approvals.filter((approval) => approval.action === 'acp.tool');
  const pendingReviews =
    snapshot?.approvals.filter(
      (approval) =>
        approval.state === 'pending' &&
        approval.action === 'git.merge' &&
        approval.projectId === root?.projectId &&
        family.some((task) => task.id === approval.taskId),
    ) ?? [];
  const openApproval = (id: string) => {
    setActionError('');
    setApprovalTarget(id);
  };
  const action = async (fn: () => Promise<unknown>) => {
    setSending(true);
    setActionError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(workbenchError(e));
      // The mutation may have been accepted despite a lost reply. Reconcile by
      // reading durable state; never resend an approval, cancellation or retry.
      await refresh();
    } finally {
      setSending(false);
    }
  };
  const send = async ({ text, attachments }: { text: string; attachments: unknown[] }) => {
    if (!workbench) throw new Error('正在连接协作引擎，草稿已保留，请稍后发送。');
    const attachmentIds = attachments.map((item) => (item as { id: string }).id);
    setSending(true);
    try {
      submission.current =
        goalSubmissions.read(goalDraftKey, goalWorkspace) ??
        (editingDraft
          ? { projectId: editingDraft.projectId, taskId: editingDraft.id }
          : {
              projectId:
                workspaceChoice.kind === 'saved-project'
                  ? workspaceChoice.projectId
                  : `hermes-${crypto.randomUUID()}`,
              createKey: crypto.randomUUID(),
              creationObjective: text.trim(),
              creationAttachmentIds: attachmentIds,
              sessionSettings: goalSettings,
              settingsAgentId: bossId,
            });
      const saveProgress = () => {
        const saved = goalSubmissions.write(goalDraftKey, goalWorkspace, submission.current!);
        setSubmissionPersisted(saved.persisted);
      };
      saveProgress();
      if (submission.current.taskId) {
        const fresh = await readConversationSnapshot(submission.current.taskId);
        const accepted = fresh.tasks.find((task) => task.id === submission.current?.taskId);
        if (accepted && accepted.state !== 'draft' && accepted.state !== 'created') {
          submission.current = undefined;
          goalSubmissions.clear(goalDraftKey);
          if (
            accepted.objective !== text.trim() ||
            !sameAttachmentIds(
              fresh.inputAttachments
                .find((item) => item.ownerId === accepted.id)
                ?.attachments.map((a) => a.id),
              attachmentIds,
            )
          )
            throw new Error(
              '上一次目标已启动，当前编辑尚未发送。请打开原会话补充，或再次发送当前目标。',
            );
          setDraft('');
          composerDrafts.clear(goalDraftKey);
          select(accepted.id);
          return;
        }
      }
      if (!selectedMemberReady) {
        openConnections(bossId || undefined);
        throw new Error(
          bossId
            ? `${selectedMemberName}：${selectedMemberIssue?.label ?? '当前不可用'}。${selectedMemberIssue?.detail ?? ''}草稿已保留。`
            : '暂时没有符合当前执行方式的成员。请在“协作成员”中检查连接和登录，草稿已保留。',
        );
      }
      // Accepted starts were reconciled above. The still-editable draft can use
      // the current choice; freeze it before the start request is issued.
      submission.current.sessionSettings = goalSettings;
      submission.current.attachmentIds = attachmentIds;
      submission.current.settingsAgentId = bossId;
      saveProgress();
      if (!editingDraft) {
        await resolveWorkspaceProject(
          workspaceChoice,
          submission.current.creationObjective ?? text,
          submission.current.projectId,
        );
      }
      const confirmation = await confirmForProject(submission.current.projectId);
      const task = await startTask(
        text,
        bossId,
        submission.current,
        confirmation,
        executionMode,
        saveProgress,
      );
      if (!editingDraft && workspaceChoice.kind === 'existing-local') {
        setWorkspaceChoice({ kind: 'saved-project', projectId: submission.current.projectId });
      }
      submission.current = undefined;
      goalSubmissions.clear(goalDraftKey);
      setDraft('');
      composerDrafts.clear(goalDraftKey);
      select(task.id);
      setRail(null);
      await refresh();
    } catch (e) {
      // A lost start response is reconciled against the durable task before offering a retry.
      if (submission.current?.taskId) {
        let data: SnapshotData;
        try {
          data = await readSnapshot();
        } catch {
          throw new Error(workbenchError(e));
        }
        const task = data.tasks.find((t) => t.id === submission.current?.taskId);
        if (task && task.state !== 'draft' && task.state !== 'created') {
          submission.current = undefined;
          goalSubmissions.clear(goalDraftKey);
          if (
            task.objective !== text.trim() ||
            !sameAttachmentIds(
              data.inputAttachments
                .find((item) => item.ownerId === task.id)
                ?.attachments.map((a) => a.id),
              attachmentIds,
            )
          )
            throw new Error(
              '上一次目标已启动，保留在左侧历史中。当前编辑尚未发送，草稿已保留；可打开原任务补充，或再次发送当前目标。',
            );
          setDraft('');
          composerDrafts.clear(goalDraftKey);
          select(task.id);
          return;
        }
      }
      throw new Error(workbenchError(e));
    } finally {
      setSending(false);
    }
  };
  const openNewTask = (workspace: WorkspaceSelection) => {
    submission.current = undefined;
    setWorkspaceChoice(workspace);
    select(null);
    setNonce((n) => n + 1);
  };
  const newTask = () => openNewTask(workspaceChoice);
  const followUp = async ({ text, attachments }: { text: string; attachments: unknown[] }) => {
    if (!root || !conversation) throw new Error('请先选择会话。');
    const attachmentIds = attachments.map((item) => (item as { id: string }).id);
    setSending(true);
    try {
      const fresh = await readSnapshot();
      const currentRounds = conversationRounds(fresh, conversation.id);
      const latest = currentRounds.at(-1);
      if (!latest) throw new Error('暂时无法读取当前会话，输入已保留，请刷新后重试。');
      const previous = followUpSubmissions.read(conversation.id);
      const source =
        previous?.text === text.trim() && sameAttachmentIds(previous.attachmentIds, attachmentIds)
          ? currentRounds.find((round) => round.id === previous.taskId)
          : undefined;
      if (previous && source) {
        const receipt = await readChatReceipt(previous.taskId, previous.key);
        if (receipt.kind !== 'missing') {
          const accepted =
            receipt.kind === 'instruction' ? receipt.instruction.content : receipt.task.objective;
          if (accepted !== previous.text)
            throw new Error('发送回执与当前内容不一致，请核对会话记录；当前文字尚未发送。');
          followUpSubmissions.clear(conversation.id);
          composerDrafts.clear(`hermes-followup-${conversation.id}`);
          if (!sameSessionValues(previous.sessionSettings, followSettings))
            setActionError('上一条追问已被接收。新选择的运行设置仍保留，供下一次发送使用。');
          else setRuntimeOverrides((saved) => ({ ...saved, [followSettingsKey]: undefined }));
          await refresh();
          return;
        }
      }
      // An in-flight instruction uses the already approved workspace. A new
      // follow-up execution still requires the existing directory confirmation.
      const target = source ?? latest;
      const canChangeSettings = canApplyNextSessionSettings(
        terminal(target),
        terminal(target) ? await readTaskExecutionActive(target.id) : true,
      );
      const confirmation = terminal(target)
        ? await confirmForProject(target.projectId, '发送')
        : undefined;
      const { request: pending } = followUpSubmissions.prepare(
        conversation.id,
        currentRounds.map((round) => round.id),
        latest.id,
        text,
        canChangeSettings ? followSettings : undefined,
        attachmentIds,
      );
      await sendChat(
        pending.taskId,
        pending.text,
        pending.key,
        confirmation,
        pending.sessionSettings,
        pending.attachmentIds,
      );
      followUpSubmissions.clear(conversation.id);
      if (canChangeSettings)
        setRuntimeOverrides((previous) => ({ ...previous, [followSettingsKey]: undefined }));
      else if (followSettings)
        setActionError(
          '补充要求已按本轮设置发送；你选择的下轮设置已保留，执行结束后的追问再使用。',
        );
      composerDrafts.clear(`hermes-followup-${conversation.id}`);
      await refresh();
    } catch (e) {
      throw new Error(workbenchError(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`${s.app} ${reading ? s.reading : ''}`}>
      <header className={s.topbar}>
        <div className={s.brand}>
          <div className={s.brandRow}>
            <button
              type="button"
              className={s.sidebarToggle}
              aria-label={sidebarCollapsed ? '展开任务列表' : '收起任务列表'}
              title={sidebarCollapsed ? '展开任务列表' : '收起任务列表'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="task-history"
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <PanelLeft size={18} />
            </button>
            <strong>Hermes 工作台</strong>
          </div>
          <small>本地多 Agent 协作</small>
        </div>
        <span className={s.activeTab}>01 工作台</span>
        <span className={s.mode}>
          {!workbench
            ? '正在连接'
            : real
              ? `真实协作 · ${snapshot?.agents.filter((a) => a.definition.enabled && a.readiness.runtime === 'ready' && ['ready', 'not_reported'].includes(a.readiness.auth)).length ?? 0} 位成员就绪`
              : '本地模拟 · 不调用付费模型'}
        </span>
        <button disabled={sending} onClick={() => openConnections()}>
          <Users size={16} /> 协作成员
        </button>
        <button onClick={() => setExternalClientsOpen(true)}>接入应用 · MCP</button>
        <button disabled={sending} onClick={() => setHelpOpen(true)}>
          使用说明
        </button>
        <button
          onClick={() => {
            setNetworkMemberId(undefined);
            setSystemSettingsOpen(true);
          }}
        >
          <Settings2 size={16} /> 系统设置
        </button>
        <button
          aria-label="切换主题"
          onClick={() => {
            setDark(!dark);
            applyThemeToDOM({
              ...DEFAULT_THEME_CONFIG,
              theme: dark ? 'light-modern' : 'dark-modern',
            });
          }}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <div className={s.layout}>
        <aside className={s.sidebar} id="task-history" hidden={sidebarCollapsed}>
          <button className={s.newTask} disabled={sending} onClick={newTask}>
            <Plus size={16} /> 新任务
          </button>
          <div className={s.sectionLabel}>
            最近任务{' '}
            <span>
              {visibleConversations.length === roots.length
                ? roots.length
                : `${visibleConversations.length} / ${roots.length}`}
            </span>
          </div>
          <div className={s.taskSearch}>
            <select
              aria-label="按项目查看任务"
              value={taskProject}
              disabled={renamingId !== null}
              onChange={(event) => setTaskProject(event.target.value)}
            >
              <option value="">全部项目</option>
              {taskProject && !historyProjects.some((project) => project.id === taskProject) && (
                <option value={taskProject}>当前筛选项目（暂无任务）</option>
              )}
              {historyProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}（{project.count}）
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="搜索历史任务"
              placeholder="搜索任务、项目或成员"
              value={taskSearch}
              disabled={renamingId !== null}
              onChange={(event) => setTaskSearch(event.target.value)}
            />
            <select
              aria-label="任务状态筛选"
              value={taskFilter}
              disabled={renamingId !== null}
              onChange={(event) => setTaskFilter(event.target.value as ConversationFilter)}
            >
              <option value="all">全部任务</option>
              <option value="active">进行中</option>
              <option value="attention">
                待处理{attentionCount ? `（${attentionCount}）` : ''}
              </option>
              <option value="completed">已完成</option>
              <option value="failed">失败或受阻</option>
              <option value="draft">草稿</option>
              <option value="cancelled">已停止</option>
            </select>
            {conversation && taskProject !== conversation.projectId && (
              <button
                type="button"
                disabled={renamingId !== null}
                onClick={() => {
                  setTaskProject(conversation.projectId);
                  setTaskSearch('');
                  setTaskFilter('all');
                }}
              >
                只看当前会话的项目
              </button>
            )}
            {(taskSearch || taskFilter !== 'all' || taskProject) && (
              <button type="button" disabled={renamingId !== null} onClick={clearTaskFilter}>
                清除筛选
              </button>
            )}
          </div>
          <nav aria-label="任务列表">
            {visibleConversations.map((task) => (
              <div key={task.id} className={s.taskRow}>
                {renamingId === task.id ? (
                  <RenameConversation
                    taskId={task.id}
                    onClose={() => setRenamingId(null)}
                    onSaved={refresh}
                  />
                ) : (
                  <>
                    <button
                      className={s.task}
                      ref={task.id === conversation?.id ? selectedTaskButton : undefined}
                      aria-current={task.id === conversation?.id ? 'page' : undefined}
                      data-selected={task.id === conversation?.id}
                      title={task.title}
                      disabled={sending}
                      onClick={() => select(task.id)}
                    >
                      <span>{task.title}</span>
                      <small
                        className={s.taskProject}
                        title={
                          historyProjects.find((project) => project.id === task.projectId)?.name
                        }
                      >
                        {historyProjects.find((project) => project.id === task.projectId)?.name}
                      </small>
                      <small data-state={needsAttention(task) ? 'attention' : task.state}>
                        {stateLabel(task.state)}
                        {task.pendingReview ? ' · 待审阅' : task.pendingApproval ? ' · 待确认' : ''}
                      </small>
                    </button>
                    <button
                      className={s.renameButton}
                      aria-label={`重命名会话：${task.title}`}
                      title="重命名会话"
                      disabled={renamingId !== null || sending}
                      onClick={() => setRenamingId(task.id)}
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </nav>
          {!roots.length && <p className={s.sidebarHint}>第一个任务完成后，记录会保留在这里。</p>}
          {!!roots.length && !visibleConversations.length && (
            <p className={s.sidebarHint} role="status">
              没有匹配的任务。试试其他关键词或清除筛选，已有记录不会删除。
            </p>
          )}
          {conversation && !visibleConversations.some((task) => task.id === conversation.id) && (
            <div className={s.sidebarHint}>
              当前会话不在筛选结果中，右侧仍可继续使用。
              <button
                className={s.locateTask}
                disabled={renamingId !== null}
                onClick={() => {
                  clearTaskFilter();
                  setLocateCurrent((value) => value + 1);
                }}
              >
                定位当前会话
              </button>
            </div>
          )}
          <div className={s.sidebarFooter}>
            <span className={s.statusDot} />{' '}
            {error ? '协作引擎连接中断' : snapshot ? '协作引擎已连接' : '正在连接协作引擎'}
            <small>任务和结果保存在本机</small>
          </div>
        </aside>
        <main className={s.main}>
          {workbench?.uiBuildId && workbench.uiBuildId !== __HERMES_BUILD_ID__ && (
            <div className={s.draftNotice} role="status">
              工作台已更新，草稿已自动保存。
              <button disabled={sending} onClick={() => location.reload()}>
                加载新版
              </button>
            </div>
          )}
          {error && (
            <div className={s.error} role="alert">
              {error}
              <button onClick={() => void refresh()}>
                <RefreshCw size={14} /> 重新连接
              </button>
            </div>
          )}
          {actionError && (
            <div className={s.error} role="alert">
              {actionError}
              <button onClick={() => setActionError('')}>关闭提示</button>
            </div>
          )}
          {activeId && !root ? (
            <div className={s.draftNotice} role="status">
              {snapshot
                ? '未找到这个会话。已有草稿仍保留，可以选择左侧任务或新建任务。'
                : '正在恢复会话和草稿…'}
              {snapshot && <button onClick={newTask}>新建任务</button>}
            </div>
          ) : !root || editingDraft ? (
            <div className={s.home} data-page-texture="pinhole">
              <PanelHero
                activeCount={roots.filter((t) => !terminal(t) && t.state !== 'draft').length}
                completedToday={
                  roots.filter(
                    (t) =>
                      t.state === 'completed' &&
                      new Date(t.updatedAt).toDateString() === new Date().toDateString(),
                  ).length
                }
                needsAttention={attentionCount}
              />
              <p className={s.intro}>
                {editingDraft
                  ? '这份草稿尚未启动。可继续修改目标，确认执行成员后发送，仍使用原任务和工作目录。'
                  : executionMode === 'direct'
                    ? '选择一位成员直接完成任务，结束后可以继续追问。草稿自动保存。'
                    : '说清楚目标，负责人会安排协作。草稿自动保存，可随时回来继续写。'}
              </p>
              {editingDraft && (
                <div className={s.draftNotice}>
                  正在编辑：{editingDraft.title}
                  <button disabled={sending} onClick={newTask}>
                    另建新任务
                  </button>
                </div>
              )}
              <div className={s.selection}>
                <label>
                  执行方式{' '}
                  <select
                    aria-label="执行方式"
                    value={executionMode}
                    disabled={sending}
                    onChange={(event) => {
                      const mode = event.target.value as ExecutionMode;
                      const candidates = snapshot ? eligibleAgents(snapshot, mode) : [];
                      changePreferences(
                        chooseExecutionMode(
                          preferencesRef.current,
                          mode,
                          candidates.map((a) => a.definition.id),
                        ),
                      );
                    }}
                  >
                    <option value="direct">直接交给成员</option>
                    <option value="collaborative">由负责人安排协作</option>
                  </select>
                </label>
                <label>
                  {executionMode === 'direct' ? '执行成员' : '负责人'}{' '}
                  <select
                    aria-label={executionMode === 'direct' ? '执行成员' : '负责人'}
                    value={bossId}
                    disabled={sending}
                    onChange={(e) =>
                      changePreferences(chooseMember(preferencesRef.current, e.target.value))
                    }
                  >
                    {bossId && !selectedMemberReady && (
                      <option value={bossId} disabled>
                        {selectedMemberName} · {selectedMemberIssue?.label ?? '当前不可用'}
                      </option>
                    )}
                    {!bossId && <option value="">暂无符合条件的成员</option>}
                    {bosses.map((a) => (
                      <option key={a.definition.id} value={a.definition.id}>
                        {a.definition.name}
                        {activeMemberIds.has(a.definition.id) ? ' · 正在处理任务' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => openConnections(undefined, true)}
                >
                  <Plus size={14} /> 添加成员
                </button>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => openConnections(bossId || undefined)}
                >
                  切换或管理成员
                </button>
                {editingDraft ? (
                  <span>
                    使用原项目工作目录：
                    {snapshot?.projects.find((project) => project.id === editingDraft.projectId)
                      ?.name ?? '原项目'}
                  </span>
                ) : (
                  <WorkspacePicker
                    key={nonce}
                    value={workspaceChoice}
                    projectName={
                      workspaceChoice.kind === 'saved-project'
                        ? snapshot?.projects.find(
                            (project) => project.id === workspaceChoice.projectId,
                          )?.name
                        : undefined
                    }
                    onChange={(choice) => {
                      submission.current = undefined;
                      setWorkspaceChoice(choice);
                    }}
                    disabled={sending}
                  />
                )}
                {editingDraft ? (
                  <AgentPermissions
                    key={editingDraft.projectId}
                    projectId={editingDraft.projectId}
                  />
                ) : workspaceChoice.kind === 'saved-project' ? (
                  <AgentPermissions
                    key={workspaceChoice.projectId}
                    projectId={workspaceChoice.projectId}
                  />
                ) : null}
              </div>
              {!editingDraft && workspaceChoice.kind === 'saved-project' && (
                <p className={s.projectNotice}>
                  在「
                  {snapshot?.projects.find((project) => project.id === workspaceChoice.projectId)
                    ?.name ?? '所选项目'}
                  」中开启新对话，沿用项目目录和权限。
                  要延续已有任务的上下文与改动，请打开原会话继续追问。
                </p>
              )}
              {snapshot && !selectedMemberReady && (
                <div className={s.connectionHint} role="status">
                  <div>
                    <strong>
                      {bossId
                        ? `${selectedMemberName} · ${selectedMemberIssue?.label ?? '当前不可用'}`
                        : executionMode === 'direct'
                          ? '连接一位成员，就能开始任务'
                          : '选择可安排协作的负责人'}
                    </strong>
                    <p>
                      {bossId
                        ? `${selectedMemberIssue?.detail ?? '请检查成员状态。'}已保留你的选择，也可以选择其他成员。`
                        : executionMode === 'direct'
                          ? '在协作成员中检查连接和登录。直接执行不要求成员具备负责人权限。'
                          : '负责人需要编排权限；也可以切换为直接执行。'}
                      可以先写目标，草稿会保留。
                    </p>
                  </div>
                  <button disabled={sending} onClick={() => openConnections(bossId || undefined)}>
                    检查协作成员
                  </button>
                  {executionMode === 'collaborative' &&
                    bossId &&
                    !memberUnavailableReason(
                      snapshot.agents.find((a) => a.definition.id === bossId),
                      'direct',
                    ) && (
                      <button
                        disabled={sending}
                        onClick={() =>
                          changePreferences(
                            chooseMember({ ...preferencesRef.current, mode: 'direct' }, bossId),
                          )
                        }
                      >
                        改为直接交给 {selectedMemberName}
                      </button>
                    )}
                </div>
              )}
              {snapshot && (
                <MemberSelectionHelp
                  agents={snapshot.agents}
                  mode={executionMode}
                  selectedId={bossId}
                  disabled={sending}
                  onInspect={openConnections}
                  onDirect={(agentId) =>
                    changePreferences(
                      chooseMember({ ...preferencesRef.current, mode: 'direct' }, agentId),
                    )
                  }
                />
              )}
              {activeMemberIds.has(bossId) && (
                <MemberWorkHint
                  name={selectedMemberName}
                  task={
                    selectedMemberTask
                      ? {
                          title: selectedMemberTask.task.title,
                          conversationTaskId: selectedMemberTask.conversationTaskId,
                        }
                      : undefined
                  }
                  disabled={sending}
                  onOpen={(taskId) => {
                    select(taskId);
                    setRail('process');
                  }}
                  onInspect={() => openConnections(bossId)}
                />
              )}
              {bossId && (
                <ComposerRuntimeSettings
                  agentId={bossId}
                  agentName={selectedMemberName}
                  projectId={
                    goalWorkspace.kind === 'saved-project' ? goalWorkspace.projectId : undefined
                  }
                  values={goalSettings}
                  disabled={sending}
                  onChange={(values) =>
                    setRuntimeOverrides((previous) => ({ ...previous, [goalSettingsKey]: values }))
                  }
                />
              )}
              <GoalComposer
                initialAttachments={
                  snapshot?.inputAttachments.find((item) => item.ownerId === editingDraft?.id)
                    ?.attachments
                }
                key={`${editingDraft?.id ?? 'new'}-${nonce}`}
                storageKey={goalDraftKey}
                initial={editingDraft?.objective ?? draft}
                editing={!!editingDraft}
                onSend={send}
                sending={sending}
              />
              {goalSubmissions.read(goalDraftKey, goalWorkspace) && (
                <p className={s.instructionReceipt} role="status">
                  {submissionPersisted
                    ? '上次发送进度已保留。再次发送会核对原项目和草稿，继续完成本次发送。'
                    : '发送进度暂时只能保留在当前页面，请先重试并确认结果，再刷新或关闭。'}
                </p>
              )}
              {!editingDraft && (
                <div className={s.examples}>
                  <span>试一试</span>
                  {(real
                    ? [
                        executionMode === 'direct'
                          ? '请检查当前项目结构，告诉我下一步可以从哪里开始。'
                          : '请设计操作台的首次使用流程，交给协作者审阅后汇总建议。',
                      ]
                    : [
                        '请安排一位协作者检查任务交接，并汇总结果。',
                        '请让协作者计算 19 × 17，并核对结果。',
                      ]
                  ).map((text) => (
                    <button
                      key={text}
                      disabled={sending}
                      onClick={() => {
                        composerDrafts.write('control-plane-draft', text);
                        setDraft(text);
                        setNonce((n) => n + 1);
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
              <div className={s.explainer}>
                <Users size={20} />
                <div>
                  <strong>输入目标，协作完成后接着聊</strong>
                  <p>
                    {executionMode === 'direct'
                      ? '成员直接处理任务。'
                      : '负责人安排分工并汇总结果。'}
                    你可以随时补充要求、查看过程与文件改动，完成后接着聊。
                    {workbench?.mode === 'mock' && '当前使用模拟协作者检查操作体验。'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className={s.taskHeader}>
                <div className={s.taskHeading}>
                  <button aria-label="返回工作台" disabled={sending} onClick={() => select(null)}>
                    <ArrowLeft size={16} />
                  </button>
                  <div className={s.taskTitle}>
                    <h1 title={conversation?.title}>{conversation?.title}</h1>
                    <small>
                      {currentProject && (
                        <span title={currentProject.name}>{currentProject.name} · </span>
                      )}
                      {leader ?? '执行成员'} · 第 {rounds.length} 轮
                      <span className={s.statePill} data-state={root.state}>
                        {stateLabel(root.state)}
                      </span>
                    </small>
                  </div>
                  <div className={s.taskNextActions}>
                    {executionApprovals.length > 0 && (
                      <button
                        className={s.pendingShortcut}
                        onClick={() => openApproval(executionApprovals[0]!.id)}
                      >
                        <ListChecks size={16} /> 待确认 {executionApprovals.length}
                      </button>
                    )}
                    {pendingReviews.length > 0 && (
                      <button
                        className={s.reviewShortcut}
                        onClick={() => {
                          setFileFocus(null);
                          setReviewFocus({ taskId: pendingReviews[0]!.taskId! });
                          setRail('files');
                        }}
                      >
                        <GitPullRequest size={16} /> 审阅改动 {pendingReviews.length}
                      </button>
                    )}
                  </div>
                </div>
                <div className={s.taskToolbar}>
                  <nav className={s.viewSwitch} aria-label="任务查看方式">
                    <button
                      aria-pressed={rail === 'process'}
                      onClick={() => setRail(rail === 'process' ? null : 'process')}
                    >
                      <ListChecks size={16} /> 过程
                    </button>
                    <button
                      aria-pressed={rail === 'files'}
                      onClick={() => {
                        setReviewFocus(undefined);
                        setRail(rail === 'files' ? null : 'files');
                      }}
                    >
                      <FileText size={16} /> 文件改动
                    </button>
                    <button
                      aria-pressed={rail === 'preview'}
                      onClick={() => {
                        setPreviewOpened(true);
                        setRail(rail === 'preview' ? null : 'preview');
                      }}
                    >
                      <Eye size={16} /> 页面预览
                    </button>
                  </nav>
                  <div className={s.taskUtilities}>
                    <button
                      type="button"
                      aria-pressed={reading}
                      onClick={() => setReading(!reading)}
                    >
                      {reading ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                      {reading ? '退出阅读（Esc）' : '放大对话'}
                    </button>

                    <button
                      aria-pressed={rail === 'agents'}
                      onClick={() => setRail(rail === 'agents' ? null : 'agents')}
                    >
                      <Users size={15} /> 协作 {allSubagents.length}
                    </button>
                    <button
                      aria-pressed={rail === 'results'}
                      onClick={() => setRail(rail === 'results' ? null : 'results')}
                    >
                      <FileText size={15} /> 产物 {artifacts.length}
                    </button>
                    {currentProject && (
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() =>
                          openNewTask({ kind: 'saved-project', projectId: currentProject.id })
                        }
                      >
                        <Plus size={14} /> 在此项目新建任务
                      </button>
                    )}
                    <AgentPermissions key={root.projectId} projectId={root.projectId} />
                  </div>
                </div>
              </div>
              <div className={s.execution}>
                <section className={s.conversation}>
                  {allSubagents.length > 0 && (
                    <div className={s.steps} aria-label="协作进度">
                      <span data-done>1 已接收目标</span>
                      <span data-done={subagents.length > 0}>
                        2{' '}
                        {subagents.length
                          ? '已委派协作者'
                          : root.state === 'failed' || root.state === 'cancelled'
                            ? '本轮执行已结束'
                            : root.state === 'blocked' || recoverable
                              ? '等待处理'
                              : root.state === 'completed'
                                ? '处理完成'
                                : '成员处理中'}
                      </span>
                      <span
                        data-done={
                          root.state === 'completed' ||
                          subagents.some((t) => t.status === 'completed')
                        }
                      >
                        3{' '}
                        {subagents.some((t) => t.status === 'completed') ||
                        root.state === 'completed'
                          ? '结果已保存'
                          : '等待结果'}
                      </span>
                      <span data-done={root.state === 'completed'}>
                        4{' '}
                        {root.state === 'completed'
                          ? '汇总完成'
                          : root.state === 'failed' || root.state === 'cancelled'
                            ? '本轮未完成'
                            : root.state === 'blocked' || recoverable
                              ? '恢复后继续'
                              : '等待汇总'}
                      </span>
                    </div>
                  )}
                  {snapshot && (
                    <PermissionNotice
                      snapshot={snapshot}
                      task={root}
                      onLocate={openApproval}
                      onInspect={() => setRail('process')}
                    />
                  )}
                  {snapshot && (
                    <TaskFeedback
                      snapshot={snapshot}
                      task={root}
                      disabled={sending}
                      onInspect={() => setRail('process')}
                      onConnections={() => openConnections()}
                      onResume={(task) =>
                        void action(async () =>
                          resumeTask(
                            task.id,
                            await confirmForProject(task.projectId, '恢复协作任务'),
                          ),
                        )
                      }
                    />
                  )}
                  {failedPreviews.length > 0 && (
                    <div className={s.draftNotice} role="status">
                      有 {failedPreviews.length}{' '}
                      个结果预览未能读取。任务历史仍保留，可查看详情并重试。
                      <button onClick={() => setRail('results')}>查看结果</button>
                    </div>
                  )}
                  {instructionError && (
                    <div className={s.draftNotice} role="status">
                      {instructionError} 任务状态和输入仍可使用。
                    </div>
                  )}
                  {snapshot?.timelineScope !== undefined && snapshot.timelineScope !== activeId && (
                    <p className={s.draftNotice} role="status">
                      正在加载本会话的过程记录…
                    </p>
                  )}
                  <div
                    className={s.timeline}
                    role="region"
                    aria-label="会话消息"
                    onClickCapture={(event) => {
                      const link =
                        event.target instanceof Element ? event.target.closest('a') : null;
                      const focus = parseWorkspaceFileHref(
                        link?.getAttribute('href') ?? '',
                        fileScopes.map((scope) => scope.taskId),
                      );
                      if (!focus) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setFileFocus(focus);
                      setReviewFocus(undefined);
                      setRail('files');
                    }}
                  >
                    <WorkspaceFileContext.Provider value={fileScopes}>
                      <MessageTimeline
                        messages={conversationMessages(
                          rounds,
                          content,
                          instructions,
                          snapshot?.artifacts ?? [],
                          snapshot,
                        )}
                        enableSpeech={false}
                        statusMessage={
                          !busy ? undefined : approvals.length ? '等待你确认操作' : undefined
                        }
                        progressModel={leader}
                        autoTts={false}
                        pendingApproval={
                          approvals.length ||
                          Boolean(
                            snapshot &&
                              conversation &&
                              root &&
                              (busy || terminal(root) || root.state === 'blocked'),
                          ) ? (
                            <>
                              {approvals.length ? (
                                <div
                                  className={s.approvals}
                                  id="task-permission-requests"
                                  tabIndex={-1}
                                >
                                  {approvals.map((a) =>
                                    a.action === 'git.merge' ? (
                                      <div key={a.id}>
                                        <strong>文件改动等待审阅</strong>
                                        <p>
                                          请在“文件改动”中检查固定差异、批准快照，再确认合入源项目。
                                        </p>
                                        <button onClick={() => setRail('files')}>
                                          查看文件改动
                                        </button>
                                      </div>
                                    ) : (
                                      <ApprovalCard
                                        key={a.id}
                                        approval={a}
                                        taskTitle={
                                          snapshot?.tasks.find((t) => t.id === a.taskId)?.title ??
                                          '当前任务'
                                        }
                                        busy={sending}
                                        onDecide={(id, decision) =>
                                          void action(() => decideApproval(id, decision))
                                        }
                                      />
                                    ),
                                  )}
                                </div>
                              ) : null}
                              {snapshot && conversation && root ? (
                                <LiveExecutionCard
                                  snapshot={snapshot}
                                  root={root}
                                  busy={busy}
                                  onInspectProcess={() => setRail('process')}
                                  onInspectArtifacts={() => setRail('results')}
                                />
                              ) : null}
                            </>
                          ) : undefined
                        }
                      />
                    </WorkspaceFileContext.Provider>
                  </div>
                  {!terminal(root) && (
                    <div className={s.taskFooter}>
                      {busy ? (
                        <span>
                          {approvals.length
                            ? '等待你确认操作，处理后继续。'
                            : root.state === 'waiting' || root.state === 'waiting_children'
                              ? '正在等待协作结果，可查看各协作任务的状态。'
                              : '任务正在执行，进度会自动更新。'}
                        </span>
                      ) : (
                        <span>{stateLabel(root.state)}</span>
                      )}
                      <button
                        disabled={sending}
                        onClick={() => void action(() => cancelTask(root.id))}
                      >
                        停止任务
                      </button>
                    </div>
                  )}
                  {conversation && currentAgentId && currentAgentName && (
                    <TaskRuntimeSettings
                      key={controlKeys!.runtimeSettings}
                      taskId={root.id}
                      agentId={currentAgentId}
                      agentName={currentAgentName}
                      projectId={root.projectId}
                      values={followSettings}
                      disabled={sending}
                      settingsLocked={!terminal(root)}
                      onChange={(values) =>
                        setRuntimeOverrides((previous) => ({
                          ...previous,
                          [followSettingsKey]: values,
                        }))
                      }
                    />
                  )}
                  {conversation && (
                    <FollowUpComposer
                      key={controlKeys!.followUpComposer}
                      conversationId={conversation.id}
                      busy={busy}
                      paused={!terminal(root) && (root.state === 'blocked' || recoverable)}
                      sending={sending}
                      resumeAvailable={recoverable}
                      queuedCount={
                        instructions.filter(
                          (item) => item.taskId === root.id && item.state === 'queued',
                        ).length
                      }
                      claimedCount={
                        instructions.filter(
                          (item) => item.taskId === root.id && item.state === 'claimed',
                        ).length
                      }
                      onSend={followUp}
                    />
                  )}
                </section>
                {rail === 'agents' && (
                  <SubagentPanel subagents={allSubagents} onClose={() => setRail(null)} />
                )}
                {rail === 'files' && (
                  <WorkspaceReviewPanel
                    taskIds={rounds.map((r) => r.id)}
                    focus={fileFocus}
                    reviewFocus={reviewFocus}
                    onClose={() => setRail(null)}
                  />
                )}
                {rail === 'process' && (
                  <ExecutionDetails
                    taskIds={rounds.map((r) => r.id)}
                    onNetwork={(agentId) => {
                      setNetworkMemberId(agentId);
                      setSystemSettingsOpen(true);
                    }}
                    onClose={() => setRail(null)}
                  />
                )}
                {rail === 'results' && (
                  <aside className={s.results}>
                    <h2>任务产物</h2>
                    {artifacts.length ? (
                      artifacts.map((a) => (
                        <article key={a.id}>
                          <strong>
                            {family.find((t) => t.resultArtifactRefs.includes(a.id))?.title ??
                              a.name ??
                              '任务结果'}
                          </strong>
                          {previewErrors[a.id] !== undefined ? (
                            <div role="status">
                              <p>结果预览读取失败：{previewErrors[a.id]}</p>
                              <button onClick={() => retryPreview(a.id)}>重新读取</button>
                            </div>
                          ) : (
                            <p>
                              {content[a.id] ??
                                (a.mimeType.startsWith('text/') || a.mimeType === 'application/json'
                                  ? '正在读取预览…'
                                  : '此文件可下载查看。')}
                            </p>
                          )}
                          <a href={artifactUrl(a.id)} download>
                            下载结果
                          </a>
                        </article>
                      ))
                    ) : (
                      <p>协作者完成后，结果会出现在这里。</p>
                    )}
                  </aside>
                )}
                {previewOpened && (
                  <div hidden={rail !== 'preview'} className={s.previewMount}>
                    <PagePreview
                      key={conversation?.id}
                      tasks={rounds}
                      onClose={() => setRail(null)}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
      <footer className={s.bottom}>
        Hermes 工作台 · 任务和对话保存在本机 <span>执行引擎：Multi-Agent Control Plane · ACP</span>
      </footer>
      {approvalTarget && snapshot && (
        <ApprovalDialog
          error={actionError}
          approval={snapshot.approvals.find((a) => a.id === approvalTarget)}
          taskTitle={
            snapshot.tasks.find(
              (t) => t.id === snapshot.approvals.find((a) => a.id === approvalTarget)?.taskId,
            )?.title ?? '当前任务'
          }
          busy={sending}
          onDecide={(id, decision) => void action(() => decideApproval(id, decision))}
          onClose={() => setApprovalTarget(undefined)}
        />
      )}
      {externalClientsOpen && (
        <ExternalClients
          projectId={
            root?.projectId ??
            (goalWorkspace.kind === 'saved-project' ? goalWorkspace.projectId : undefined)
          }
          onClose={() => setExternalClientsOpen(false)}
        />
      )}
      {connectionsOpen && (
        <AgentConnections
          initialMemberId={connectionTarget}
          initialAdd={connectionAdd}
          selectedMemberId={!root || editingDraft ? bossId : undefined}
          selectingForDraft={!root || !!editingDraft}
          projectId={
            root?.projectId ??
            (goalWorkspace.kind === 'saved-project' ? goalWorkspace.projectId : undefined)
          }
          onClose={() => setConnectionsOpen(false)}
          onChanged={refresh}
          onOpenTask={(taskId) => {
            setConnectionsOpen(false);
            select(taskId);
            setRail('process');
          }}
          onUse={(agentId, mode) => {
            if (sending) return;
            // Unstarted drafts keep their identity, text and project. Existing
            // conversations keep their executor; the choice starts a separate task in that project.
            changePreferences(chooseMember({ ...preferencesRef.current, mode }, agentId));
            if (activeId !== null && !editingDraft)
              openNewTask(
                root ? { kind: 'saved-project', projectId: root.projectId } : workspaceChoice,
              );
            setConnectionsOpen(false);
          }}
          activeAgentIds={snapshot ? [...activeMemberIds] : undefined}
          onNetwork={(agentId) => {
            setNetworkMemberId(agentId);
            setSystemSettingsOpen(true);
          }}
          networkVersion={networkVersion}
        />
      )}
      {helpOpen && (
        <WorkbenchHelp
          hasCurrentTask={!!root && !editingDraft}
          onClose={() => setHelpOpen(false)}
          onMembers={() => {
            setHelpOpen(false);
            openConnections();
          }}
          onNewTask={() => {
            setHelpOpen(false);
            newTask();
          }}
          onCurrentTask={() => {
            setHelpOpen(false);
            setRail('process');
          }}
        />
      )}
      {systemSettingsOpen && (
        <SystemSettings
          initialMemberId={networkMemberId}
          onClose={() => {
            setSystemSettingsOpen(false);
            setNetworkVersion((value) => value + 1);
          }}
          onSaved={() => {
            setNetworkVersion((value) => value + 1);
            void refresh();
          }}
        />
      )}
      {confirmationDialog}
    </div>
  );
}

async function bootstrap() {
  applyPlatformToDOM('web');
  applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, theme: 'light-modern' });
  await initUiStore();
  const store = getDefaultStore();
  store.set(assistantDisplayNameAtom, '协作成员');
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <QueryClientProvider client={new QueryClient()}>
        <Provider store={store}>
          <ConfirmProvider>
            <BrowserRouter>
              <Workbench />
            </BrowserRouter>
          </ConfirmProvider>
        </Provider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}
void bootstrap();
