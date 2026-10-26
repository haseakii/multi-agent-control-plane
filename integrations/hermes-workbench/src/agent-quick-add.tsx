import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { memberActionRequest } from './member-action-request';
import { saveAgentWithRecovery } from './agent-save-recovery';
import {
  AgentConnection,
  AgentDefinition,
  configurationError,
  ensureAgentIdle,
  type AgentConnectionData,
} from './agent-config';
import { appendAgentCandidates, parseAgentCommands, sameAgentRuntime } from './agent-quick-config';
import { readAgentConfigFile } from './agent-config-file';
import { AgentProducts } from './agent-products';
import { AgentRuntimeRepair } from './agent-runtime-repair';
import { entryIssueText, entryConnectionError } from './agent-entry-feedback';
import { usableOnboardingMember } from './agent-selection';
import { runConnectionBatch, type ConnectionBatchProgress } from './connection-batch';
import {
  connectionQueue,
  onboardingStatus,
  onboardingStatusLabels,
  onboardingSummary,
} from './onboarding-progress';
import {
  onboardingDraftKey,
  readOnboardingDraft,
  reconcileOnboardingRows,
  writeOnboardingDraft,
  type CatalogSelectionData,
} from './agent-onboarding-draft';
import s from './agent-connections.module.css';

type Candidate = {
  id: string;
  name: string;
  runtime?: AgentConnectionData['definition']['runtime'];
  selected: boolean;
  leader: boolean;
  error?: string;
  saved?: AgentConnectionData;
  existing?: AgentConnectionData;
  done?: boolean;
  message?: string;
  attempted?: boolean;
  catalogSelection?: CatalogSelectionData;
};

export function AgentQuickAdd({
  disabled,
  onCancel,
  onManual,
  onSaved,
  onUse,
  selectingForDraft = false,
  onBusy,
}: {
  disabled: boolean;
  onCancel: () => void;
  onManual: () => void;
  onSaved: (agents: AgentConnectionData[], focusId?: string) => void;
  onUse: (agentId: string) => void;
  selectingForDraft?: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [initial] = useState(() => {
    try {
      return readOnboardingDraft(sessionStorage);
    } catch {
      return [];
    }
  });
  const [command, setCommand] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  useEffect(
    () => () => {
      fileRead.current++;
    },
    [],
  );
  const [mode, setMode] = useState<'products' | 'paste' | 'review'>(
    initial.length ? 'review' : 'products',
  );
  const [rows, setRows] = useState<Candidate[]>(initial);
  const [restoring, setRestoring] = useState(!!initial.length);
  const [restoreError, setRestoreError] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [draftStatus, setDraftStatus] = useState('empty');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const flight = useRef(false);
  const pauseRequested = useRef(false);
  const [pausing, setPausing] = useState(false);
  const [progress, setProgress] = useState<ConnectionBatchProgress<Candidate>>();
  const [batchNotice, setBatchNotice] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const update = (id: string, value: Partial<Candidate>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...value } : row)));

  useEffect(() => {
    if (!initial.length) return;
    let live = true;
    setRestoring(true);
    setRestoreError(false);
    void memberActionRequest('members', (signal) =>
      fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
    )
      .then((agents) => {
        if (live) setRows(reconcileOnboardingRows(initial, agents));
      })
      .catch(() => {
        if (live) setRestoreError(true);
      })
      .finally(() => {
        if (live) setRestoring(false);
      });
    return () => {
      live = false;
    };
  }, [initial, restoreVersion]);
  useEffect(() => {
    try {
      setDraftStatus(writeOnboardingDraft(sessionStorage, rows));
    } catch {
      setDraftStatus('unavailable');
    }
  }, [rows]);
  const blocked = disabled || restoring || restoreError || readingFile;
  function preserveUnfinished() {
    try {
      writeOnboardingDraft(
        sessionStorage,
        rows.filter((row) => !row.done),
      );
    } catch {
      /* storage may be disabled */
    }
  }
  function finish(focusId?: string) {
    preserveUnfinished();
    onSaved(saved, focusId);
  }
  function useMember(row: Candidate) {
    const member = usableOnboardingMember(row);
    if (blocked || busy || editingId || !member) return;
    preserveUnfinished();
    onUse(member.definition.id);
  }

  function preview(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      addPreview(parseAgentCommands(command));
    } catch (failure) {
      setError(configurationError(failure));
    }
  }

  function addPreview(entries: ReturnType<typeof parseAgentCommands>, filename?: string) {
    const additions = entries.map((entry) => ({
      id: `agent-${crypto.randomUUID()}`,
      name: entry.name,
      runtime: entry.parsed?.runtime,
      error: entry.error,
      selected: !!entry.parsed,
      leader: false,
    }));
    const merged = appendAgentCandidates(rows, additions);
    const added = merged.length - rows.length;
    const duplicates = additions.length - added;
    setRows(merged);
    setImportNotice(
      `${filename ? `已读取“${filename}”。` : ''}已加入 ${added} 位成员${duplicates ? `；${duplicates} 项配置已在待接入列表中，保留原项及其进度` : ''}。尚未启动程序，请核对后接入。`,
    );
    setBatchNotice('');
    setMode('review');
    if (!filename) setCommand('');
  }

  async function importFile(file: File) {
    if (blocked || busy) return;
    const generation = ++fileRead.current;
    setReadingFile(true);
    setError('');
    try {
      const entries = await readAgentConfigFile(file);
      if (fileRead.current === generation) addPreview(entries, file.name);
    } catch (failure) {
      if (fileRead.current === generation) setError(configurationError(failure));
    } finally {
      if (fileRead.current === generation) setReadingFile(false);
    }
  }

  async function connect(memberId?: string) {
    if (blocked || flight.current || editingId) return;
    const queue = connectionQueue(rows, memberId);
    if (!queue.length) return;
    flight.current = true;
    pauseRequested.current = false;
    setPausing(false);
    setBatchNotice('');
    setProgress({ completed: 0, total: queue.length });
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      // Existing members are never enabled, reconfigured or probed by importing duplicates.
      const existing = await memberActionRequest('members', (signal) =>
        fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
      );
      const result = await runConnectionBatch(
        queue,
        async (row) => {
          // Recover a completed registration if its HTTP response was lost.
          let saved = row.saved ?? existing.find((item) => item.definition.id === row.id);
          try {
            const duplicate = existing.find(
              (item) =>
                item.definition.id !== row.id &&
                sameAgentRuntime(item.definition.runtime, row.runtime!),
            );
            if (!saved && duplicate) {
              update(row.id, {
                done: true,
                existing: duplicate,
                error: undefined,
                message: `已存在：${duplicate.definition.name}。保留现有设置，请在成员卡片使用。`,
              });
              return;
            }
            if (saved && duplicate)
              throw new Error(
                `此入口已由“${duplicate.definition.name}”使用，请修正入口，或完成接入后使用已有成员。`,
              );
            update(row.id, {
              error: undefined,
              attempted: true,
              message: saved ? '已保存，重新检查连接…' : '正在检查本机入口…',
            });
            const definition = AgentDefinition.parse({
              id: row.id,
              name: row.name.trim(),
              enabled: true,
              runtime: row.runtime,
              capabilities: [],
              auth: { mode: 'agent-managed' },
              orchestration: { canBeBoss: row.leader },
              controlBridge: row.leader
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
                : { transport: 'none', scopes: [] },
            });
            const runtimeChanged =
              saved && !sameAgentRuntime(saved.definition.runtime, row.runtime!);
            if (!saved || runtimeChanged) {
              const check = await memberActionRequest('entry', (signal) =>
                fetchJSON(
                  '/api/agents/check-local',
                  { method: 'POST', body: JSON.stringify(definition), signal },
                  z.object({
                    offlineChecksPassed: z.boolean(),
                    issues: z.array(z.object({ code: z.string(), message: z.string() })),
                  }),
                ),
              );
              if (!check.offlineChecksPassed)
                throw new Error(check.issues.map(entryIssueText).join('；'));
              const current = saved;
              if (current)
                await memberActionRequest('activity', (signal) =>
                  ensureAgentIdle(current.definition.id, signal),
                );
              saved = await saveAgentWithRecovery(
                current ? { ...current.definition, runtime: definition.runtime } : definition,
                (signal) =>
                  fetchJSON(
                    current
                      ? `/api/agents/${encodeURIComponent(current.definition.id)}`
                      : row.catalogSelection
                        ? '/api/agent-catalog/register'
                        : '/api/agents',
                    {
                      method: current ? 'PATCH' : 'POST',
                      body: JSON.stringify(
                        current
                          ? {
                              runtime: definition.runtime,
                              ...(current.definitionHash
                                ? { expectedDefinitionHash: current.definitionHash }
                                : {}),
                            }
                          : row.catalogSelection
                            ? {
                                entryId: row.catalogSelection.entryId,
                                expectedCatalogVersion: row.catalogSelection.version,
                                definition,
                              }
                            : definition,
                      ),
                      signal,
                    },
                    AgentConnection,
                  ),
                (signal) => fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
                () => update(row.id, { message: '保存回复尚未收到，正在核对已有配置…' }),
              );
              const index = existing.findIndex(
                (item) => item.definition.id === saved!.definition.id,
              );
              if (index >= 0) existing[index] = saved;
              else existing.push(saved);
              update(row.id, { saved });
            }
            update(row.id, { message: '已保存，正在检查 ACP 连接…' });
            saved = await memberActionRequest('probe', (signal) =>
              fetchJSON(
                `/api/agents/${encodeURIComponent(row.id)}/probe`,
                { method: 'POST', body: '{}', signal },
                AgentConnection,
              ),
            );
            const connected = saved.readiness.runtime === 'ready';
            update(row.id, {
              saved,
              done: connected,
              error: connected ? undefined : entryConnectionError(saved.error),
              message: connected
                ? saved.readiness.auth === 'ready'
                  ? '连接正常，已登录，可以使用。'
                  : saved.readiness.auth === 'not_reported'
                    ? '连接正常；程序未报告登录状态，可在成员卡片继续。'
                    : '连接正常；请在成员卡片完成登录确认。'
                : '成员已保存，连接失败。可以在下方修正入口和参数后重试。',
            });
          } catch (failure) {
            update(row.id, {
              saved,
              error: configurationError(failure),
              message: saved
                ? '成员配置已保存。请按上方原因处理，或前往成员查看最新状态；其他成员继续接入。'
                : '本次接入尚未确认。草稿已保留，重试时会先核对已有成员；其他成员继续接入。',
            });
          }
        },
        () => pauseRequested.current,
        setProgress,
      );
      setBatchNotice(
        result.paused
          ? `已暂停：检查了 ${result.completed} / ${result.total} 位成员。已保存的配置保留，未完成项可稍后继续。`
          : `本次 ${result.total} 位成员检查结束。连接或登录仍需处理的成员，请按各卡片提示继续。`,
      );
    } catch (failure) {
      setError(configurationError(failure));
    } finally {
      flight.current = false;
      setProgress(undefined);
      setPausing(false);
      setBusy(false);
      onBusy(false);
    }
  }

  const saved = rows.flatMap((row) => (row.saved ? [row.saved] : []));
  const remaining = connectionQueue(rows).length;
  const started = rows.some((row) => row.attempted || row.saved || row.done);
  if (mode === 'products')
    return (
      <AgentProducts
        disabled={blocked}
        onPaste={() => setMode('paste')}
        onCancel={() => (rows.length ? setMode('review') : onCancel())}
        cancelLabel={rows.length ? `返回待接入列表（${rows.length}）` : undefined}
        onExisting={(id) => finish(id)}
        onUse={onUse}
        onBusy={onBusy}
        onPrepare={(name, runtime, catalogSelection) => {
          const matching = rows.find(
            (row) => row.runtime && sameAgentRuntime(row.runtime, runtime),
          );
          const refreshVersion =
            matching &&
            !matching.saved &&
            !matching.done &&
            catalogSelection &&
            matching.catalogSelection?.entryId === catalogSelection.entryId &&
            matching.catalogSelection.version !== catalogSelection.version;
          const merged = refreshVersion
            ? rows.map((row) =>
                row.id === matching.id
                  ? {
                      ...row,
                      catalogSelection,
                      error: undefined,
                      message: '已按本次目录选择更新版本，原有入口与待接入身份保留。',
                    }
                  : row,
              )
            : appendAgentCandidates(rows, [
                {
                  id: `agent-${crypto.randomUUID()}`,
                  name,
                  runtime,
                  selected: true,
                  leader: false,
                  ...(catalogSelection ? { catalogSelection } : {}),
                },
              ]);
          setRows(merged);
          setImportNotice(
            refreshVersion
              ? '已核对并更新待接入项的目录版本；确认后可重试接入。'
              : merged.length === rows.length
                ? '此入口已在待接入列表中，保留原项及其进度。'
                : `已将 ${name} 加入待接入列表。`,
          );
          setBatchNotice('');
          setMode('review');
          setError('');
        }}
      />
    );
  return (
    <form
      className={s.editor}
      aria-label="快速接入 ACP"
      onSubmit={
        mode === 'review'
          ? (event) => {
              event.preventDefault();
              void connect();
            }
          : preview
      }
    >
      <h3>{mode === 'review' ? '确认要接入的成员' : '导入 ACP 配置'}</h3>
      <p className={s.hint}>选择产品或导入配置 → 确认成员 → 检查连接与登录</p>
      {importNotice && !started && (
        <p className={s.notice} role="status">
          {importNotice}
        </p>
      )}
      {busy && progress && (
        <div className={s.batchProgress}>
          <p role="status">
            {progress.current
              ? `正在检查第 ${progress.completed + 1} / ${progress.total} 位：${progress.current.name}`
              : `正在准备检查 · ${progress.completed} / ${progress.total} 位已检查`}
          </p>
          <progress
            aria-label="成员接入进度"
            max={progress.total || 1}
            value={progress.completed}
          />
          <button
            type="button"
            disabled={pausing}
            onClick={() => {
              pauseRequested.current = true;
              setPausing(true);
            }}
          >
            {pausing ? '等待当前检查结束…' : '当前检查结束后暂停'}
          </button>
          <p className={s.hint}>
            当前成员返回结果或等待超时后暂停；后台操作可能仍在进行，稍后可核对状态。
          </p>
        </div>
      )}
      {batchNotice && (
        <div className={s.batchProgress}>
          <p role="status">{batchNotice}</p>
        </div>
      )}
      {restoring && (
        <p role="status" className={s.notice}>
          正在恢复草稿，并核对服务端已有成员…
        </p>
      )}
      {restoreError && (
        <div role="alert" className={s.error}>
          草稿已保留，暂时无法核对已有成员。连接恢复后可继续。
          <button type="button" onClick={() => setRestoreVersion((value) => value + 1)}>
            重新核对已有成员
          </button>
        </div>
      )}
      {draftStatus === 'saved' && (
        <p className={s.hint}>
          待接入列表已保存在本标签页，刷新或稍后打开成员面板可继续。粘贴的命令需先加入列表才会保存。
        </p>
      )}
      {draftStatus === 'sensitive' && (
        <p className={s.hint}>启动参数含凭据相关内容，本次草稿未缓存。请由 Agent 自己管理登录。</p>
      )}
      {draftStatus === 'unavailable' && (
        <p className={s.hint}>浏览器暂时无法保存接入草稿，请保持当前页面打开。</p>
      )}
      {mode === 'review' && (
        <p role="status" className={s.hint}>
          {onboardingSummary(rows)}
          {started
            ? '。可以逐项重试，或取消勾选暂不处理的成员；成功项不会重复检查。'
            : '。接入前可以逐项修正入口。'}
        </p>
      )}
      {mode === 'paste' ? (
        <fieldset className={s.fields} disabled={blocked || busy}>
          <button type="button" onClick={() => setMode('products')}>
            从产品目录选择
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label="选择 ACP 配置文件"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importFile(file);
            }}
          />
          <button type="button" onClick={() => fileInput.current?.click()}>
            {readingFile ? '正在读取配置…' : '从 JSON 文件读取并预览'}
          </button>
          <p className={s.hint}>
            文件只在当前浏览器读取，最多 256 KB、20
            位成员。先预览再接入；不会导入登录凭据或自动授予负责人权限。
          </p>
          <label className={s.field}>
            ACP 启动命令或 JSON 配置
            <textarea
              required
              rows={6}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              spellCheck={false}
              placeholder={
                '"C:\\Tools\\agent.exe" --stdio\n或粘贴包含多个成员的 agent_servers JSON'
              }
            />
          </label>
          <p className={s.hint}>
            支持单个命令、runtime 或多个 agent_servers
            条目。使用本机已安装程序的完整路径，环境变量只填名称。下一步只预览，不启动程序。
          </p>
          <details className={s.details}>
            <summary>配置格式示例</summary>
            <pre className={s.configExample}>
              {
                '{"agent_servers": {\n  "开发助手": {"command": "C:/Tools/agent.exe", "args": ["--stdio"]},\n  "审阅助手": {"command": "C:/Tools/node.exe", "args": ["C:/Tools/reviewer/index.js"]}\n}}'
              }
            </pre>
          </details>
          <button type="button" onClick={onManual}>
            手动填写详细参数
          </button>
        </fieldset>
      ) : (
        <fieldset className={s.fields} disabled={blocked || busy}>
          {rows.map((row) => (
            <section className={s.card} key={row.id} aria-label={`${row.name} 接入配置`}>
              <p className={s.hint}>接入状态：{onboardingStatusLabels[onboardingStatus(row)]}</p>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={row.selected}
                  disabled={!row.runtime || row.done}
                  aria-label={`批量检查 ${row.name || '未命名成员'}`}
                  onChange={(event) => update(row.id, { selected: event.target.checked })}
                />
                {row.name || '未命名成员'}
              </label>
              {row.runtime && (
                <>
                  <p className={s.hint}>
                    {row.catalogSelection
                      ? `选定目录来源：${row.catalogSelection.entryId} · ${row.catalogSelection.version}；注册时会再次核对目录版本。`
                      : '自定义启动入口；未自动关联目录来源。'}
                  </p>
                  <label className={s.field}>
                    显示名称
                    <input
                      required={row.selected}
                      value={row.name}
                      disabled={!!row.saved || row.done}
                      onChange={(event) => update(row.id, { name: event.target.value })}
                    />
                  </label>
                  <details className={s.details}>
                    <summary>启动入口与参数</summary>
                    <div className={s.configExample}>
                      <code>{row.runtime.command}</code>
                      <br />
                      <code>{JSON.stringify(row.runtime.args)}</code>
                    </div>
                    {row.runtime.cwd && <p className={s.hint}>启动目录：{row.runtime.cwd}</p>}
                    {!!row.runtime.environmentAllowlist?.length && (
                      <p className={s.hint}>
                        环境变量名称：{row.runtime.environmentAllowlist.join('、')}
                      </p>
                    )}
                  </details>
                  <label className={s.check}>
                    <input
                      type="checkbox"
                      checked={row.leader}
                      disabled={!!row.saved || row.done}
                      onChange={(event) => update(row.id, { leader: event.target.checked })}
                    />
                    允许担任负责人
                  </label>
                  {row.leader && (
                    <p className={s.hint}>
                      允许创建和委派任务、发送协作消息、读写产物及报告状态。程序需支持 MCP。
                    </p>
                  )}
                </>
              )}
              {row.message && (
                <p className={s.notice} role="status">
                  {row.message}
                </p>
              )}
              {row.error && (
                <p className={s.error} role="alert">
                  {row.error}
                </p>
              )}
              {!row.done && row.runtime && (row.attempted || row.saved) && (
                <button type="button" disabled={!!editingId} onClick={() => void connect(row.id)}>
                  只重试此成员
                </button>
              )}
              {row.saved && (
                <button
                  type="button"
                  disabled={!!editingId}
                  onClick={() => finish(row.saved!.definition.id)}
                >
                  查看连接详情
                </button>
              )}
              {usableOnboardingMember(row) && (
                <button
                  type="button"
                  className={s.primary}
                  disabled={blocked || busy || !!editingId}
                  onClick={() => useMember(row)}
                >
                  选用 {(row.saved ?? row.existing)!.definition.name}，
                  {selectingForDraft ? '返回草稿' : '新建任务'}
                </button>
              )}
              {row.existing && (
                <button
                  type="button"
                  disabled={!!editingId}
                  onClick={() => finish(row.existing!.definition.id)}
                >
                  前往已有成员：{row.existing.definition.name}
                </button>
              )}
              {!row.done &&
                (editingId === row.id ? (
                  <AgentRuntimeRepair
                    key={row.id}
                    runtime={row.runtime}
                    onCancel={() => setEditingId(undefined)}
                    onApply={(runtime) => {
                      update(row.id, {
                        runtime,
                        selected: true,
                        error: undefined,
                        message: '入口已修正，点击下方接入或重试完成检查。',
                      });
                      setEditingId(undefined);
                    }}
                  />
                ) : (
                  <button type="button" disabled={!!editingId} onClick={() => setEditingId(row.id)}>
                    修正入口和参数
                  </button>
                ))}
              {!row.saved && !row.done && editingId !== row.id && (
                <button
                  type="button"
                  disabled={!!editingId}
                  onClick={() => {
                    setRows((current) => current.filter((item) => item.id !== row.id));
                    if (rows.length === 1) setMode('products');
                  }}
                >
                  移除此项
                </button>
              )}
            </section>
          ))}
        </fieldset>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.actions}>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            mode === 'paste' && rows.length
              ? setMode('review')
              : saved.length || started
                ? finish()
                : onCancel()
          }
        >
          {mode === 'paste' && rows.length
            ? `返回待接入列表（${rows.length}）`
            : started
              ? '完成，查看成员'
              : '稍后继续'}
        </button>
        {rows.length > 0 && (
          <button
            type="button"
            disabled={busy || restoring}
            onClick={() => {
              try {
                sessionStorage.removeItem(onboardingDraftKey);
              } catch {
                /* no cache */
              }
              onCancel();
            }}
          >
            丢弃接入草稿
          </button>
        )}
        {mode === 'review' && (
          <>
            <button
              type="button"
              disabled={blocked || busy || !!editingId || rows.length >= 20}
              onClick={() => setMode('products')}
            >
              再添加一个产品
            </button>
            <button
              type="button"
              disabled={blocked || busy || !!editingId || rows.length >= 20}
              onClick={() => setMode('paste')}
            >
              导入更多配置
            </button>
          </>
        )}
        {(mode === 'paste' || remaining > 0) && (
          <button type="submit" disabled={busy || blocked || !!editingId} className={s.primary}>
            {busy
              ? '正在逐项接入…'
              : mode === 'paste'
                ? '下一步，预览成员'
                : started
                  ? `继续检查未完成的 ${remaining} 位`
                  : `接入所选 ${remaining} 位成员`}
          </button>
        )}
      </div>
      <p className={s.hint}>
        接入时保存配置并检查连接，不发送模型任务。登录由各个 Agent 自己管理。
      </p>
    </form>
  );
}
