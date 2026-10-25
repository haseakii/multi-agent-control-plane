import { useCallback, useEffect, useRef, useState } from 'react';
import { readOnboardingDraft } from './agent-onboarding-draft';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { memberActionRequest } from './member-action-request';
import {
  AgentConnection,
  Activity,
  activeAgents,
  type AgentConnectionData as Connection,
} from './agent-config';
import { AgentEditor } from './agent-editor';
import {
  MemberActivity,
  recentMemberTask,
  memberProgramIdentity,
  memberExecutionLabel,
  type MemberActivityData,
} from './member-history';
import {
  agentEditorFields,
  readAgentEditorDraft,
  type AgentEditorRecovery,
} from './agent-editor-draft';
import { AgentQuickAdd } from './agent-quick-add';
import { AgentManagement } from './agent-management';
import { SessionSettingsControl } from './agent-session-settings';
import { MemberOverviewReader } from './member-overview-reader';
import { selectableAgents, type ExecutionMode } from './agent-selection';
import { filterMembers, memberStatus, type MemberFilter } from './member-list';
import { entryConnectionError, entryIssueText } from './agent-entry-feedback';
import s from './agent-connections.module.css';

const runtimeLabels = { unknown: '尚未检查', ready: '连接正常', error: '连接失败' };
const authLabels = {
  unknown: '登录状态未知',
  needs_login: '需要登录',
  ready: '已登录',
  not_reported: '未报告登录状态',
};

function leaderStatus(agent: Connection) {
  const { definition, readiness } = agent;
  if (!definition.enabled) return '已停用，暂不参与新任务。';
  if (readiness.runtime !== 'ready') return '先检查本机连接，连接和登录就绪后可直接执行任务。';
  if (!['ready', 'not_reported'].includes(readiness.auth))
    return '连接已就绪，请确认登录后开始任务。';
  if (!definition.orchestration.canBeBoss) return '可直接执行任务，也可接受负责人的分工。';
  if (
    definition.controlBridge.transport !== 'mcp' ||
    !definition.controlBridge.scopes.includes('boss.orchestration')
  ) {
    return '可直接执行任务。任务编排接口尚未接通，暂不能安排其他成员。';
  }
  return '可直接执行，也可担任负责人安排协作并汇总结果。';
}

function errorText(error: unknown, action: 'read' | 'probe' | 'auth' = 'read') {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return '未能连接本地服务。请确认操作台服务仍在运行，再重试。';
  }
  if (message.includes('HTTP 409')) return '当前状态已变化，请刷新状态后重试。';
  if (message.includes('HTTP 502'))
    return action === 'auth'
      ? '协作者未能完成登录。请在它自己的应用或命令行中登录，再检查连接。'
      : action === 'probe'
        ? '连接检查未完成，请查看成员诊断并核对启动入口。此次检查失败不代表登录已失效。'
        : '暂时无法读取成员状态，请稍后刷新。';
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export type AgentConnectionsProps = {
  initialMemberId?: string;
  initialAdd?: boolean;
  selectedMemberId?: string;
  selectingForDraft?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onUse: (agentId: string, mode: ExecutionMode) => void;
  onOpenTask: (taskId: string) => void;
  activeAgentIds?: readonly string[];
  projectId?: string;
};

/** Connection actions are deliberate user actions; opening this drawer only reads state. */
export function AgentConnections({
  initialMemberId,
  initialAdd = false,
  selectedMemberId,
  selectingForDraft = false,
  onClose,
  onChanged,
  onUse,
  onOpenTask,
  activeAgentIds,
  projectId,
}: AgentConnectionsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionInFlight = useRef(false);
  const [agents, setAgents] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<{ id: string; kind: 'probe' | 'auth' } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [observedActive, setObservedActive] = useState<string[]>([]);
  const [memberActivity, setMemberActivity] = useState<MemberActivityData>();
  const [activityNotice, setActivityNotice] = useState('');
  const overview = useRef<MemberOverviewReader<Connection[], MemberActivityData> | undefined>(
    undefined,
  );
  const [editing, setEditing] = useState<
    (Connection & { editorDraft?: AgentEditorRecovery }) | 'new' | null
  >(initialAdd ? 'new' : null);
  const [configBusy, setConfigBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');
  const [focusMember, setFocusMember] = useState<string | undefined>(initialMemberId);
  const memberCards = useRef(new Map<string, HTMLElement>());
  const active = new Set(activeAgentIds ?? observedActive);
  const visibleMembers = filterMembers(agents, memberSearch, memberFilter, active);
  const memberCounts = { ready: 0, busy: 0, attention: 0, disabled: 0 };
  for (const agent of agents) memberCounts[memberStatus(agent, active)]++;
  let hasOnboardingDraft = false;
  try {
    hasOnboardingDraft = readOnboardingDraft(sessionStorage).length > 0;
  } catch {
    /* browser storage unavailable */
  }

  const refresh = useCallback(async (clearError = true) => {
    if (clearError) setError('');
    await overview.current?.refresh();
  }, []);

  useEffect(() => {
    dialog.current?.showModal();
    const reader = new MemberOverviewReader<Connection[], MemberActivityData>(
      {
        read: (signal) => fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
        loading: () => setLoading(true),
        apply: (connections) => {
          setAgents(connections);
          setLoading(false);
        },
        failed: (failure) => {
          setError(errorText(failure));
          setLoading(false);
        },
      },
      {
        read: (signal) =>
          fetchJSON('/api/control-center?view=conversation', { signal }, MemberActivity),
        loading: () => setActivityNotice('正在更新最近执行…'),
        apply: (activity) => {
          setObservedActive(activeAgents(activity));
          setMemberActivity(activity);
          setActivityNotice('');
        },
        failed: () =>
          setActivityNotice(
            '最近执行暂未更新；已显示的记录可能过时。成员配置仍可查看，请点击刷新状态重试。',
          ),
      },
    );
    overview.current = reader;
    void refresh();
    return () => {
      reader.dispose();
      overview.current = undefined;
    };
  }, [refresh]);
  useEffect(() => {
    if (!editing) return;
    const form = dialog.current?.querySelector('form');
    form?.scrollIntoView({ block: 'start', behavior: 'auto' });
    form?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => {
    if (!focusMember || loading || editing) return;
    const card = memberCards.current.get(focusMember);
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: 'auto' });
    card.focus({ preventScroll: true });
    setFocusMember(undefined);
  }, [focusMember, loading, editing, agents]);

  function revealMember(id?: string) {
    setMemberSearch('');
    setMemberFilter('all');
    setFocusMember(id);
  }

  async function act(agent: Connection, kind: 'probe' | 'auth', methodId?: string) {
    if (actionInFlight.current || configBusy || active.has(agent.definition.id)) return;
    actionInFlight.current = true;
    setPending({ id: agent.definition.id, kind });
    setError('');
    setNotice('');
    try {
      // Refresh activity before launching an independent connection process.
      const activity = await memberActionRequest('activity', (signal) =>
        fetchJSON('/api/control-center?view=conversation', { signal }, Activity),
      );
      const currentActive = activeAgents(activity);
      setObservedActive(currentActive);
      if (currentActive.includes(agent.definition.id)) {
        setNotice(`${agent.definition.name} 正在处理任务，请等任务结束后再检查或登录。`);
        return;
      }
      const next = await memberActionRequest(kind, (signal) =>
        fetchJSON(
          `/api/agents/${encodeURIComponent(agent.definition.id)}/${kind}`,
          { method: 'POST', body: JSON.stringify(kind === 'auth' ? { methodId } : {}), signal },
          AgentConnection,
        ),
      );
      setAgents((current) =>
        current.map((item) => (item.definition.id === next.definition.id ? next : item)),
      );
      setNotice(
        kind === 'auth'
          ? next.readiness.auth === 'ready'
            ? `${next.definition.name} 已完成登录确认。`
            : `${next.definition.name} 返回的登录状态为“${authLabels[next.readiness.auth]}”，尚未确认登录成功。`
          : `${next.definition.name} 检查完成：${runtimeLabels[next.readiness.runtime]}，${authLabels[next.readiness.auth]}。`,
      );
      onChanged();
    } catch (failure) {
      setError(errorText(failure, kind));
      // The backend may update readiness even when authentication fails.
      await refresh(false);
      onChanged();
    } finally {
      actionInFlight.current = false;
      setPending(null);
    }
  }

  return (
    <dialog
      className={s.drawer}
      ref={dialog}
      aria-labelledby="agent-connections-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!configBusy && !pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !configBusy && !pending) onClose();
      }}
    >
      <div className={s.surface}>
        <header className={s.header}>
          <div>
            <h2 id="agent-connections-title">协作者连接</h2>
            <p>
              {selectingForDraft
                ? '选用成员后返回当前草稿，保留已输入的目标和工作目录。'
                : '选用成员会在当前项目新建任务，已有会话仍由原成员继续处理。'}
            </p>
          </div>
          <button
            type="button"
            className={s.close}
            onClick={onClose}
            disabled={configBusy || pending !== null}
            aria-label="关闭协作者连接"
            autoFocus
          >
            ×
          </button>
        </header>
        <div className={s.body}>
          <div className={s.summary}>
            <span>{loading ? '正在读取状态…' : `已注册 ${agents.length} 位协作者`}</span>
            <button
              type="button"
              onClick={() => void refresh().then(onChanged)}
              disabled={loading || pending !== null || configBusy}
            >
              刷新状态
            </button>
          </div>
          <nav className={s.views} aria-label="成员管理视图">
            <button
              type="button"
              aria-pressed={editing !== 'new'}
              disabled={pending !== null || configBusy}
              onClick={() => setEditing(null)}
            >
              已接入 <span>{agents.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={editing === 'new'}
              disabled={loading || pending !== null || configBusy}
              onClick={() => {
                setManual(false);
                setEditing('new');
              }}
            >
              {hasOnboardingDraft ? '添加成员 · 有草稿' : '＋ 添加成员'}
            </button>
          </nav>
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className={s.notice} role="status">
              {notice}
            </p>
          )}
          {activityNotice && (
            <p className={s.hint} role="status">
              {activityNotice}
            </p>
          )}
          {!loading && !error && !agents.length && !editing && (
            <p className={s.empty}>当前服务没有注册协作者。请先接入本机已安装的 ACP 协作者。</p>
          )}
          {editing === 'new' && !manual && (
            <AgentQuickAdd
              disabled={pending !== null || loading}
              onBusy={(busy) => {
                setConfigBusy(busy);
                if (!busy) {
                  void refresh(false);
                  onChanged();
                }
              }}
              onCancel={() => setEditing(null)}
              onManual={() => setManual(true)}
              onUse={(id) => {
                onChanged();
                onUse(id, 'direct');
              }}
              selectingForDraft={selectingForDraft}
              onSaved={(saved, focusId) => {
                setEditing(null);
                revealMember(focusId ?? (saved.length === 1 ? saved[0].definition.id : undefined));
                setNotice(
                  focusId
                    ? '已定位到成员。查看连接与登录状态后，可直接选择它开始任务；未完成的接入草稿仍保留。'
                    : saved.length
                      ? `已保存 ${saved.length} 位成员。请在下方查看各自的连接与登录状态。`
                      : '接入检查结束。现有成员设置保持不变。',
                );
                void refresh();
                onChanged();
              }}
            />
          )}
          {editing && (editing !== 'new' || manual) && (
            <AgentEditor
              key={
                editing === 'new'
                  ? 'new'
                  : `${editing.definition.id}:${editing.definitionHash ?? ''}`
              }
              agent={editing === 'new' ? undefined : editing}
              disabled={pending !== null || loading}
              active={editing !== 'new' && active.has(editing.definition.id)}
              onBusy={setConfigBusy}
              onCancel={() => setEditing(null)}
              recovery={editing === 'new' ? undefined : editing.editorDraft}
              onReload={(latest, editorDraft) => setEditing({ ...latest, editorDraft })}
              onSaved={(saved) => {
                setEditing(null);
                revealMember(saved.definition.id);
                setNotice(
                  `${saved.definition.name} 已保存${saved.definition.enabled ? '' : '为停用状态'}。${!saved.definition.enabled ? '请启用成员，然后检查连接与登录。' : saved.readiness.runtime === 'ready' && ['ready', 'not_reported'].includes(saved.readiness.auth) ? '已有连接状态已保留，可继续使用。' : '请查看下方连接与登录状态，按提示完成检查。'}`,
                );
                void refresh();
                onChanged();
              }}
            />
          )}
          {!editing && agents.length > 0 && (
            <section className={s.memberFilters} aria-label="查找协作成员">
              <label className={s.field}>
                搜索已接入成员
                <input
                  type="search"
                  value={memberSearch}
                  placeholder="名称、能力或注册标识"
                  onChange={(event) => setMemberSearch(event.target.value)}
                />
              </label>
              <label className={s.field}>
                成员状态
                <select
                  value={memberFilter}
                  onChange={(event) => setMemberFilter(event.target.value as MemberFilter)}
                >
                  <option value="all">全部成员（{agents.length}）</option>
                  <option value="ready">可开始任务（{memberCounts.ready}）</option>
                  <option value="busy">正在处理任务（{memberCounts.busy}）</option>
                  <option value="attention">待处理连接或登录（{memberCounts.attention}）</option>
                  <option value="disabled">已停用（{memberCounts.disabled}）</option>
                </select>
              </label>
              <p className={s.hint} role="status">
                显示 {visibleMembers.length} / {agents.length} 位成员
              </p>
              {(memberSearch || memberFilter !== 'all') && (
                <button type="button" onClick={() => revealMember()}>
                  清除筛选
                </button>
              )}
              {!visibleMembers.length && (
                <p className={s.empty}>
                  没有符合条件的成员。可以调整搜索或清除筛选；现有成员配置仍保留。
                </p>
              )}
            </section>
          )}
          {(editing === 'new'
            ? []
            : editing
              ? agents.filter((agent) => agent.definition.id === editing.definition.id)
              : visibleMembers
          ).map((agent) => {
            const id = agent.definition.id;
            const busy = active.has(id);
            const working = pending?.id === id;
            const availableMethods = agent.authMethods.filter(
              (method) => method.type !== 'terminal',
            );
            const selectedMethod = availableMethods.some((method) => method.id === methods[id])
              ? methods[id]
              : availableMethods[0]?.id;
            const loginNeeded =
              agent.readiness.auth === 'unknown' || agent.readiness.auth === 'needs_login';
            const disabled = pending !== null || loading || busy || configBusy;
            const directReady = selectableAgents([agent], 'direct').length > 0;
            const collaborativeReady = selectableAgents([agent], 'collaborative').length > 0;
            const current = busy ? recentMemberTask(memberActivity, id, true) : undefined;
            const recent = current ?? recentMemberTask(memberActivity, id);
            const program = memberProgramIdentity(agent.negotiation?.agentInfo);
            let hasEditDraft = false;
            try {
              hasEditDraft = !!readAgentEditorDraft(
                sessionStorage,
                id,
                agentEditorFields(agent.definition),
              );
            } catch {
              /* optional browser storage */
            }
            return (
              <section
                className={s.card}
                key={id}
                aria-label={`${agent.definition.name} 连接状态`}
                tabIndex={-1}
                ref={(node) => {
                  if (node) memberCards.current.set(id, node);
                  else memberCards.current.delete(id);
                }}
              >
                <div className={s.cardHeader}>
                  <h3>{agent.definition.name}</h3>
                  {selectedMemberId === id && <span className={s.badge}>当前选择</span>}
                  <span className={s.badge} data-ready={agent.readiness.runtime === 'ready'}>
                    {busy
                      ? '正在处理任务'
                      : !agent.definition.enabled
                        ? '已停用'
                        : runtimeLabels[agent.readiness.runtime]}
                  </span>
                </div>
                {program && <p className={s.programIdentity}>程序上报：{program}</p>}
                <p className={s.role}>{leaderStatus(agent)}</p>
                {recent && (
                  <section
                    className={s.recentTask}
                    aria-label={`${agent.definition.name} 最近执行`}
                  >
                    <span>
                      {current ? '当前执行' : '最近执行'} · {memberExecutionLabel(recent.state)}
                    </span>
                    <strong title={recent.task.title}>{recent.task.title}</strong>
                    <button
                      type="button"
                      disabled={pending !== null || configBusy || editing !== null}
                      onClick={() => onOpenTask(recent.conversationTaskId)}
                    >
                      {current
                        ? '前往当前任务，查看或补充要求'
                        : ['failed', 'interrupted'].includes(recent.state)
                          ? '查看失败过程'
                          : '查看任务过程'}
                    </button>
                  </section>
                )}
                {hasEditDraft && !editing && (
                  <div className={s.actions}>
                    <span>有未保存的配置草稿</span>
                    <button type="button" disabled={disabled} onClick={() => setEditing(agent)}>
                      继续编辑草稿
                    </button>
                  </div>
                )}
                {directReady && (
                  <div className={s.actions}>
                    <button
                      type="button"
                      className={s.primary}
                      disabled={disabled || editing !== null}
                      aria-label={
                        selectingForDraft
                          ? `选用 ${agent.definition.name}，返回草稿`
                          : `用 ${agent.definition.name} 新建任务`
                      }
                      onClick={() => onUse(id, 'direct')}
                    >
                      {selectingForDraft ? '选用此成员，返回草稿' : '用此成员新建任务'}
                    </button>
                    {collaborativeReady && (
                      <button
                        type="button"
                        disabled={disabled || editing !== null}
                        aria-label={`由 ${agent.definition.name} 安排协作`}
                        onClick={() => onUse(id, 'collaborative')}
                      >
                        由它安排协作
                      </button>
                    )}
                  </div>
                )}
                <div className={s.actions}>
                  <SessionSettingsControl
                    agentId={id}
                    agentName={agent.definition.name}
                    projectId={projectId}
                    disabled={disabled || editing !== null}
                  />
                </div>
                <dl className={s.status}>
                  <div>
                    <dt>连接</dt>
                    <dd>{runtimeLabels[agent.readiness.runtime]}</dd>
                  </div>
                  <div>
                    <dt>登录</dt>
                    <dd>{authLabels[agent.readiness.auth]}</dd>
                  </div>
                </dl>
                {agent.error && <p className={s.error}>{entryConnectionError(agent.error)}</p>}
                {agent.localEntry && !agent.localEntry.offlineChecksPassed && (
                  <div className={s.error}>
                    <strong>本机启动入口需要处理</strong>
                    <ul>
                      {agent.localEntry.issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>{entryIssueText(issue)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {((agent.error && agent.readiness.runtime === 'error') ||
                  agent.localEntry?.offlineChecksPassed === false) && (
                  <div className={s.actions}>
                    <button
                      type="button"
                      disabled={disabled || editing !== null}
                      onClick={() => setEditing(agent)}
                    >
                      修正启动入口
                    </button>
                  </div>
                )}
                <div className={s.actions}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void act(agent, 'probe')}
                  >
                    {working && pending.kind === 'probe' ? '检查中…' : '检查连接'}
                  </button>
                  {loginNeeded && availableMethods.length > 0 && (
                    <>
                      {availableMethods.length > 1 && (
                        <select
                          aria-label={`${agent.definition.name} 登录方式`}
                          value={selectedMethod}
                          disabled={disabled}
                          onChange={(event) =>
                            setMethods((current) => ({ ...current, [id]: event.target.value }))
                          }
                        >
                          {availableMethods.map((method) => (
                            <option key={method.id} value={method.id}>
                              {method.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className={s.primary}
                        disabled={
                          disabled || agent.readiness.runtime !== 'ready' || !selectedMethod
                        }
                        onClick={() => void act(agent, 'auth', selectedMethod)}
                      >
                        {working && pending.kind === 'auth' ? '等待登录完成…' : '登录 / 确认登录'}
                      </button>
                    </>
                  )}
                </div>
                {busy && (
                  <p className={s.hint}>
                    {current
                      ? '可进入当前任务查看过程、补充要求或继续追问。'
                      : '正在处理任务，当前记录可能尚未更新，可刷新状态查看。'}
                    结束后可检查连接或重新登录，也可以选择其他空闲成员开始任务。
                  </p>
                )}
                {agent.readiness.auth === 'not_reported' && (
                  <p className={s.hint}>
                    此程序不报告登录状态。连接正常时可尝试任务；若任务提示认证失败，再到程序自己的登录入口处理。
                  </p>
                )}
                {working && pending.kind === 'auth' && (
                  <p className={s.hint}>请留意协作者打开的登录窗口。确认可能需要几分钟。</p>
                )}
                {!busy && loginNeeded && availableMethods.length > 0 && (
                  <p className={s.hint}>点击登录后，由协作者自己的登录流程处理授权。</p>
                )}
                {loginNeeded && agent.authMethods.some((method) => method.type === 'terminal') && (
                  <p className={s.hint}>
                    此协作者也提供终端登录；请在它的命令行中完成，然后重新检查连接。
                  </p>
                )}
                {loginNeeded &&
                  !agent.authMethods.length &&
                  agent.readiness.runtime === 'ready' && (
                    <p className={s.hint}>
                      协作者未提供网页可用的登录方式。请使用它自己的应用或命令行登录。
                    </p>
                  )}
                <details className={s.details}>
                  <summary>连接信息</summary>
                  <dl>
                    <dt>注册标识</dt>
                    <dd>{id}</dd>
                    <dt>检查时间</dt>
                    <dd>{new Date(agent.readiness.observedAt).toLocaleString()}</dd>
                    <dt>协作能力</dt>
                    <dd>
                      {agent.definition.controlBridge.scopes.length
                        ? agent.definition.controlBridge.scopes.join(' · ')
                        : '接收分配的任务'}
                    </dd>
                  </dl>
                  {agent.error && <p>{agent.error}</p>}
                </details>
                <AgentManagement
                  agent={agent}
                  disabled={pending !== null || loading || configBusy || editing !== null}
                  active={busy}
                  onBusy={setConfigBusy}
                  onEdit={() => {
                    setEditing(agent);
                  }}
                  onChanged={(message) => {
                    setNotice(message);
                    void refresh();
                    onChanged();
                  }}
                />
              </section>
            );
          })}
        </div>
        <footer className={s.footer}>
          {editing === 'new'
            ? '从产品目录选择或导入启动入口；接入后查看登录状态，再开始使用。'
            : '选择成员后回到工作台填写目标；运行设置可为每位成员保存模型偏好。'}
        </footer>
      </div>
    </dialog>
  );
}
