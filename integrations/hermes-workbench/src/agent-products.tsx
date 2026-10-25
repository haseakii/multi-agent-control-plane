import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import {
  AgentDefinition,
  AgentRuntime,
  AgentConnection,
  configurationError,
  type AgentConnectionData,
} from './agent-config';
import { parseAgentCommand, sameAgentRuntime } from './agent-quick-config';
import type { CatalogSelectionData } from './agent-onboarding-draft';
import { prepareProductEntry } from './product-entry';
import { AgentArguments } from './agent-arguments';
import { AgentInstall } from './agent-install';
import { SnapshotRefresh } from './snapshot-refresh';
import {
  clearProductEntryDraft,
  readProductEntryDraft,
  writeProductEntryDraft,
  type ProductEntryFields,
} from './product-entry-draft';
import s from './agent-connections.module.css';

const Product = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  website: z.string().optional(),
  repository: z.string().optional(),
  distribution: z.object({
    binary: z
      .record(z.string(), z.object({ cmd: z.string(), args: z.array(z.string()).optional() }))
      .optional(),
    npx: z.object({ package: z.string(), args: z.array(z.string()).optional() }).optional(),
    uvx: z.object({ package: z.string(), args: z.array(z.string()).optional() }).optional(),
  }),
});
const LocalCheck = z.object({
  entryId: z.string(),
  state: z.enum(['not-checked', 'found', 'not-found', 'stale']),
  checkedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  candidateCount: z.number().int().nonnegative().optional(),
  scope: z.enum(['common-locations', 'selected-directory']).optional(),
});
const MemberStatus = z.object({
  entryId: z.string(),
  registeredCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  localEntryCount: z.number().int().nonnegative(),
  changedSourceCount: z.number().int().nonnegative(),
  localCheck: LocalCheck,
});
const Catalog = z.object({
  entries: z.array(Product),
  platform: z.string(),
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  memberStatuses: z.array(MemberStatus).default([]),
});
const Discovery = z.object({
  candidates: z.array(
    z.object({
      source: z.enum(['registered', 'path', 'directory', 'package']),
      agentId: z.string().optional(),
      association: z.enum(['linked', 'possible']).optional(),
      name: z.string(),
      packageName: z.string().optional(),
      packageVersion: z.string().optional(),
      runtime: AgentRuntime,
    }),
  ),
  searchedDirectories: z.number(),
  note: z.string(),
  localCheck: LocalCheck.optional(),
});
function safeLink(value?: string) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function AgentProducts({
  disabled,
  onPaste,
  onCancel,
  onExisting,
  onPrepare,
  cancelLabel,
  onBusy,
}: {
  disabled: boolean;
  onPaste: () => void;
  onCancel: () => void;
  onExisting: (agentId?: string) => void;
  onPrepare: (
    name: string,
    runtime: z.infer<typeof AgentDefinition>['runtime'],
    catalogSelection?: CatalogSelectionData,
  ) => void;
  cancelLabel?: string;
  onBusy: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<z.infer<typeof Catalog>>();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(8);
  const [selected, setSelected] = useState<z.infer<typeof Product>>();
  const [discovery, setDiscovery] = useState<z.infer<typeof Discovery>>();
  const [knownMembers, setKnownMembers] = useState<AgentConnectionData[]>([]);
  const [checkingVisible, setCheckingVisible] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [associationNotice, setAssociationNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const [directory, setDirectory] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string[]>([]);
  const [nodeMode, setNodeMode] = useState(false);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [draftStatus, setDraftStatus] = useState('empty');
  const [restored, setRestored] = useState(false);
  const activeRead = useRef<{ dispose(): void } | undefined>(undefined);
  function stopWaiting() {
    activeRead.current?.dispose();
    activeRead.current = undefined;
    setBusy(false);
    setError('');
  }
  async function read<T>(
    request: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    timeoutMessage: string,
  ) {
    activeRead.current?.dispose();
    setBusy(true);
    setError('');
    const next = new SnapshotRefresh(
      request,
      apply,
      (failure) => setError(configurationError(failure)),
      15_000,
      timeoutMessage,
    );
    activeRead.current = next;
    await next.refresh();
    if (activeRead.current === next) {
      activeRead.current = undefined;
      setBusy(false);
    }
  }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    void read(
      (signal) => fetchJSON('/api/agent-catalog', { signal }, Catalog),
      setCatalog,
      '读取产品目录超时。可以重新加载，或直接粘贴命令与批量配置。',
    );
    return () => {
      activeRead.current?.dispose();
      activeRead.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    try {
      setDraftStatus(
        writeProductEntryDraft(sessionStorage, selected.id, {
          directory,
          command,
          args,
          script,
          nodeMode,
        }),
      );
    } catch {
      setDraftStatus('unavailable');
    }
  }, [selected?.id, directory, command, args, script, nodeMode]);
  function entryDraft(id: string) {
    try {
      return readProductEntryDraft(sessionStorage, id);
    } catch {
      return undefined;
    }
  }
  function fill(fields: ProductEntryFields) {
    setDirectory(fields.directory);
    setCommand(fields.command);
    setArgs(fields.args);
    setScript(fields.script);
    setNodeMode(fields.nodeMode);
  }
  function defaultFields(product: z.infer<typeof Product>): ProductEntryFields {
    return {
      directory: '',
      command: '',
      args: [],
      script: '',
      nodeMode:
        !!product.distribution.npx && !product.distribution.binary?.[catalog?.platform ?? ''],
    };
  }
  function prepare(name: string, runtime: z.infer<typeof AgentDefinition>['runtime']) {
    onPrepare(
      name,
      runtime,
      selected ? { entryId: selected.id, version: selected.version } : undefined,
    );
    if (selected) {
      try {
        clearProductEntryDraft(sessionStorage, selected.id);
      } catch {
        /* optional storage */
      }
    }
  }
  async function refresh() {
    if (busy) return;
    await read(
      (signal) =>
        fetchJSON('/api/agent-catalog/refresh', { method: 'POST', body: '{}', signal }, Catalog),
      setCatalog,
      '刷新产品目录尚未返回结果。已显示的目录仍保留，可稍后重试或直接粘贴配置。',
    );
  }
  async function discover(product: z.infer<typeof Product>, directory?: string) {
    setAssociationNotice('');
    await read(
      async (signal) => {
        const results = await Promise.allSettled([
          fetchJSON(
            '/api/agent-catalog/discover-local',
            {
              method: 'POST',
              body: JSON.stringify({ entryId: product.id, ...(directory ? { directory } : {}) }),
              signal,
            },
            Discovery,
          ),
          fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
        ]);
        if (results[0].status === 'rejected') throw results[0].reason;
        return {
          discovery: results[0].value,
          members: results[1].status === 'fulfilled' ? results[1].value : [],
        };
      },
      (next) => {
        setDiscovery(next.discovery);
        setKnownMembers(next.members);
        if (next.discovery.localCheck)
          setCatalog((previous) =>
            previous
              ? {
                  ...previous,
                  memberStatuses: previous.memberStatuses.map((status) =>
                    status.entryId === product.id
                      ? { ...status, localCheck: next.discovery.localCheck! }
                      : status,
                  ),
                }
              : previous,
          );
      },
      '查找本机入口超时。已填路径、参数和上次结果仍保留，可重新查找或手动填写；本次查找不会注册成员。',
    );
  }
  async function checkVisible() {
    if (busy || !products.length) return;
    const ids = products.slice(0, limit).map((product) => product.id);
    setCheckingVisible(true);
    try {
      await read(
        async (signal) => {
          const statuses: z.infer<typeof MemberStatus>[] = [];
          for (let offset = 0; offset < ids.length; offset += 8) {
            if (signal.aborted) throw new DOMException('已停止等待入口检查。', 'AbortError');
            const result = await fetchJSON(
              '/api/agent-catalog/check-visible',
              {
                method: 'POST',
                body: JSON.stringify({ entryIds: ids.slice(offset, offset + 8) }),
                signal,
              },
              z.object({ memberStatuses: z.array(MemberStatus).max(8) }),
            );
            statuses.push(...result.memberStatuses);
          }
          return statuses;
        },
        (statuses) =>
          setCatalog((previous) =>
            previous
              ? {
                  ...previous,
                  memberStatuses: [
                    ...previous.memberStatuses.filter(
                      (status) => !statuses.some((next) => next.entryId === status.entryId),
                    ),
                    ...statuses,
                  ],
                }
              : previous,
          ),
        '检查入口超时；已显示结果与草稿保留，可重试当前显示项。',
      );
    } finally {
      setCheckingVisible(false);
    }
  }
  async function associate(candidate: z.infer<typeof Discovery>['candidates'][number]) {
    const member = knownMembers.find((item) => item.definition.id === candidate.agentId);
    if (
      busy ||
      !selected ||
      !member?.definitionHash ||
      !sameAgentRuntime(member.definition.runtime, candidate.runtime)
    )
      return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setAssociating(true);
    onBusy(true);
    setError('');
    setAssociationNotice('');
    try {
      const saved = await fetchJSON(
        '/api/agent-catalog/associate',
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            entryId: selected.id,
            expectedCatalogVersion: selected.version,
            agentId: member.definition.id,
            expectedDefinitionHash: member.definitionHash,
            expectedRevision: member.registrationSource?.record?.revision ?? 0,
          }),
        },
        AgentConnection,
      );
      if (
        saved.registrationSource?.status !== 'linked' ||
        saved.registrationSource.record?.entryId !== selected.id ||
        saved.registrationSource.record.catalogVersion !== selected.version
      )
        throw new Error('返回的目录来源尚未匹配当前产品，请刷新核对。');
      setKnownMembers((previous) =>
        previous.map((item) => (item.definition.id === saved.definition.id ? saved : item)),
      );
      setDiscovery((previous) =>
        previous
          ? {
              ...previous,
              candidates: previous.candidates.map((item) =>
                item.source === 'registered' && item.agentId === saved.definition.id
                  ? { ...item, association: 'linked' }
                  : item,
              ),
            }
          : previous,
      );
      setAssociationNotice(
        `已将 ${saved.definition.name} 关联到 ${selected.name}。这只记录你选择的目录来源，不代表软件签名或登录验证；连接与权限保持原样。`,
      );
      try {
        setCatalog(await fetchJSON('/api/agent-catalog', { signal: controller.signal }, Catalog));
      } catch {
        /* The authoritative association reply is sufficient; counts can be refreshed later. */
      }
    } catch (cause) {
      setError(
        `${configurationError(cause)}。关联结果尚未确认，请重新查找后核对；不会自动重试来源写入。`,
      );
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
      setAssociating(false);
      onBusy(false);
    }
  }
  function checkState(check?: z.infer<typeof LocalCheck>) {
    if (!check) return 'not-checked';
    if (check.expiresAt && Date.parse(check.expiresAt) <= now) return 'stale';
    return check.state;
  }
  function checkLabel(check?: z.infer<typeof LocalCheck>) {
    const state = checkState(check);
    if (state === 'not-checked') return '本机入口尚未检查';
    if (state === 'stale') return '入口检查已过期，需重新检查';
    if (state === 'found') return `上次发现 ${check?.candidateCount ?? 0} 个入口`;
    return check?.scope === 'selected-directory' ? '指定目录未发现入口' : '常用位置未发现入口';
  }
  function select(product: z.infer<typeof Product>) {
    setDiscovery(undefined);
    setKnownMembers([]);
    setSelected(product);
    const draft = entryDraft(product.id);
    fill(draft ?? defaultFields(product));
    setRestored(!!draft);
    void discover(product);
  }
  const unfinished = new Set(
    (catalog?.entries ?? [])
      .filter((product) => entryDraft(product.id))
      .map((product) => product.id),
  );
  const products = (catalog?.entries ?? []).filter(
    (product) =>
      (!onlyDrafts || unfinished.has(product.id)) &&
      `${product.name} ${product.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const productLink = safeLink(selected?.website) ?? safeLink(selected?.repository);
  const suggestedArgs =
    (nodeMode
      ? selected?.distribution.npx
      : selected?.distribution.binary?.[catalog?.platform ?? '']
    )?.args ?? [];
  return (
    <section className={s.editor} aria-label="选择 ACP 产品">
      <h3>{selected ? `接入 ${selected.name}` : '选择要接入的产品'}</h3>
      <p className={s.hint}>选择产品 → 安装或使用已有入口 → 成员自己登录</p>
      <AgentInstall entryId={selected?.id} onExisting={onExisting} />
      {!selected ? (
        <>
          <div className={s.actions}>
            <button type="button" disabled={disabled || busy} onClick={() => void refresh()}>
              {busy ? '正在刷新…' : catalog?.entries.length ? '刷新产品目录' : '加载产品目录'}
            </button>
            <button type="button" disabled={disabled} onClick={onPaste}>
              粘贴命令或导入配置文件
            </button>
            <button
              type="button"
              disabled={disabled || busy || !products.length}
              onClick={() => void checkVisible()}
            >
              {checkingVisible
                ? '正在检查显示项…'
                : `检查当前显示的 ${Math.min(products.length, limit)} 项入口`}
            </button>
          </div>
          <p className={s.hint}>
            入口检查只读取本机元数据，不启动成员、不登录或安装。常用位置未发现入口不代表尚未安装。
          </p>
          <p className={s.hint}>关联数仅表示用户选择的目录来源，不代表软件签名或登录验证。</p>
          <p className={s.hint}>
            {catalog?.fetchedAt
              ? `${catalog.entries.length} 个产品 · ${catalog.stale ? '缓存较旧，建议刷新' : '目录已缓存，可离线查看'}`
              : '加载只获取 ACP 官方目录，不安装软件。'}
            {catalog?.platform ? ` · ${catalog.platform}` : ''}
          </p>
          {(unfinished.size > 0 || onlyDrafts) && (
            <button
              type="button"
              aria-pressed={onlyDrafts}
              onClick={() => {
                setOnlyDrafts((value) => !value);
                setSearch('');
                setLimit(8);
              }}
            >
              {onlyDrafts ? '查看所有产品' : `继续未完成入口（${unfinished.size}）`}
            </button>
          )}
          {busy && (
            <button type="button" onClick={stopWaiting}>
              停止等待目录
            </button>
          )}
          {catalog?.error && (
            <p role="alert" className={s.error}>
              {catalog.error}
            </p>
          )}
          <label className={s.field}>
            搜索产品
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(8);
              }}
              placeholder="例如 Codex、Antigravity、Gemini"
            />
          </label>
          <div className={s.productList}>
            {products.slice(0, limit).map((product) => {
              const status = catalog?.memberStatuses.find((item) => item.entryId === product.id);
              return (
                <button
                  type="button"
                  key={product.id}
                  disabled={disabled || busy}
                  className={s.productChoice}
                  onClick={() => void select(product)}
                >
                  <strong>{product.name}</strong>
                  <span>目录版本 {product.version}</span>
                  <span className={s.productAssociation}>
                    {status
                      ? `已关联 ${status.registeredCount} 位成员 · ${status.readyCount} 位最近确认就绪`
                      : '目录关联状态尚未读取'}
                  </span>
                  {!!status?.changedSourceCount && (
                    <span className={s.sourceAttention}>
                      {status.changedSourceCount} 位成员入口已变化，来源待核对
                    </span>
                  )}
                  <span
                    className={s.productLocalStatus}
                    data-local-check={checkState(status?.localCheck)}
                  >
                    {checkLabel(status?.localCheck)}
                  </span>
                  {status?.localCheck.checkedAt && (
                    <small>
                      检查于 {new Date(status.localCheck.checkedAt).toLocaleString('zh-CN')}
                    </small>
                  )}
                  {unfinished.has(product.id) && <span>有未完成入口 · 继续填写</span>}
                  <small>
                    {product.distribution.binary?.[catalog!.platform]
                      ? '目录提供本平台程序包'
                      : product.distribution.npx || product.distribution.uvx
                        ? '目录提供适配器包'
                        : '请确认本机兼容性'}
                  </small>
                </button>
              );
            })}
          </div>
          {!!catalog?.entries.length && !products.length && (
            <p className={s.hint}>没有匹配项。仍可粘贴自定义 ACP 配置。</p>
          )}
          {products.length > limit && (
            <button type="button" onClick={() => setLimit((value) => value + 8)}>
              再显示 8 个产品
            </button>
          )}
        </>
      ) : (
        <>
          <p className={s.hint}>{selected.description}</p>
          {restored && (
            <p className={s.notice} role="status">
              已恢复此产品的入口草稿，请核对后再加入待接入列表。
            </p>
          )}
          {draftStatus === 'saved' && (
            <p className={s.hint}>
              入口草稿已保存在本标签页；切换产品、关闭面板或刷新后可继续填写。尚未注册成员。
            </p>
          )}
          {draftStatus === 'sensitive' && (
            <p className={s.hint}>输入含疑似凭据，未缓存此入口。请使用成员自己的登录流程。</p>
          )}
          {draftStatus === 'unavailable' && (
            <p className={s.hint}>浏览器暂不能保存草稿，请先完成预览再离开此页。</p>
          )}
          <p className={s.hint}>
            目录版本 {selected.version}，不代表本机已安装版本。
            {productLink && (
              <a href={productLink} target="_blank" rel="noopener noreferrer">
                查看产品说明
              </a>
            )}
          </p>
          {associationNotice && (
            <p role="status" className={s.notice}>
              {associationNotice}
            </p>
          )}
          {discovery?.localCheck && (
            <p className={s.hint}>
              {checkLabel(discovery.localCheck)}
              {discovery.localCheck.checkedAt
                ? ` · 检查于 ${new Date(discovery.localCheck.checkedAt).toLocaleString('zh-CN')}`
                : ''}
            </p>
          )}
          {busy && (
            <p role="status" className={s.notice}>
              {associating ? '正在保存你确认的目录来源…' : '正在查找本机程序和已安装的适配器包…'}
            </p>
          )}
          <div className={s.actions}>
            {busy && !associating ? (
              <button type="button" onClick={stopWaiting}>
                停止等待查找
              </button>
            ) : (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => void discover(selected, directory.trim() || undefined)}
              >
                重新查找本机入口
              </button>
            )}
          </div>
          {busy && !associating && (
            <p className={s.hint}>可以停止等待并手动填写；已输入的路径和参数会保留。</p>
          )}
          {discovery && (
            <>
              {discovery.candidates.map((candidate, index) => {
                const member = knownMembers.find(
                  (item) => item.definition.id === candidate.agentId,
                );
                const canAssociate =
                  !!member?.definitionHash &&
                  sameAgentRuntime(member.definition.runtime, candidate.runtime);
                return (
                  <div
                    className={s.card}
                    key={`${candidate.agentId ?? candidate.runtime.command}-${index}`}
                  >
                    <strong>
                      {candidate.source === 'registered'
                        ? `${candidate.association === 'linked' ? '已关联成员' : '可能相同的已有成员'}：${candidate.name}`
                        : candidate.source === 'package'
                          ? '找到已安装的适配器包'
                          : '找到候选本机入口'}
                    </strong>
                    <p className={s.configExample}>{candidate.runtime.command}</p>
                    {candidate.packageName && (
                      <p className={s.hint}>
                        {candidate.packageName}
                        {candidate.packageVersion
                          ? ` · 本机声明版本 ${candidate.packageVersion}`
                          : ''}
                      </p>
                    )}
                    {!!candidate.runtime.args.length && (
                      <p className={s.configExample}>{candidate.runtime.args.join('\n')}</p>
                    )}
                    {candidate.source === 'registered' ? (
                      <>
                        {candidate.association !== 'linked' && (
                          <>
                            <p className={s.hint}>
                              这是按名称或入口文件名找到的候选，需要你确认后才记录目录关联。
                            </p>
                            {member?.registrationSource?.record && (
                              <p className={s.hint}>
                                当前来源记录：{member.registrationSource.record.entryName} ·{' '}
                                {member.registrationSource.record.catalogVersion}
                                {member.registrationSource.status === 'entry-changed'
                                  ? '（入口已变化）'
                                  : ''}
                              </p>
                            )}
                            <button
                              type="button"
                              disabled={disabled || busy || !canAssociate}
                              onClick={() => void associate(candidate)}
                            >
                              确认关联到 {selected.name}
                            </button>
                            {!canAssociate && (
                              <p className={s.hint}>
                                尚未核对当前成员版本或入口已变化，请重新查找后关联。
                              </p>
                            )}
                          </>
                        )}
                        <button
                          type="button"
                          disabled={disabled || busy}
                          onClick={() => onExisting(candidate.agentId)}
                        >
                          查看已有成员
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={s.primary}
                        disabled={disabled || busy}
                        onClick={() => {
                          setError('');
                          try {
                            const suggested =
                              candidate.source === 'package'
                                ? (selected.distribution.npx?.args ?? [])
                                : (selected.distribution.binary?.[catalog?.platform ?? '']?.args ??
                                  []);
                            prepare(
                              selected.name,
                              prepareProductEntry(candidate.runtime, suggested),
                            );
                          } catch (failure) {
                            setError(configurationError(failure));
                          }
                        }}
                      >
                        使用此入口，预览成员
                      </button>
                    )}
                    {candidate.source !== 'registered' && (
                      <p className={s.hint}>
                        下一步确认程序与产品建议参数，可修改后再接入；此时不会启动程序。
                      </p>
                    )}
                  </div>
                );
              })}
              {!discovery.candidates.length && (
                <p className={s.notice}>
                  常用位置未发现入口。已安装到其他位置时，可以检查安装目录；也可手动填写程序路径。此结果不代表未安装。
                </p>
              )}
              <p className={s.hint}>{discovery.note}</p>
            </>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void discover(selected, directory.trim());
            }}
          >
            <label className={s.field}>
              已安装到其他位置？
              <input
                value={directory}
                disabled={disabled || busy}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="填写安装目录，例如 D:/Tools/adapter"
                aria-label="已安装目录"
              />
              <small>
                支持程序目录、Node 包目录或安装项目目录。只检查已安装文件，不下载或安装。
              </small>
            </label>
            <button type="submit" disabled={disabled || busy || !directory.trim()}>
              检查安装目录
            </button>
          </form>
          <details className={s.details}>
            <summary>手动填写程序、脚本或启动参数</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setError('');
                try {
                  const parsed = parseAgentCommand(
                    JSON.stringify({
                      command: command.trim(),
                      args: nodeMode ? [script.trim(), ...args] : args,
                    }),
                  );
                  prepare(selected.name, parsed.runtime);
                } catch (failure) {
                  setError(configurationError(failure));
                }
              }}
            >
              <fieldset className={s.fields} disabled={disabled || busy}>
                <label className={s.field}>
                  {nodeMode ? 'Node.js 程序路径' : '本机程序路径'}
                  <input
                    required
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder={
                      nodeMode ? 'C:/Program Files/nodejs/node.exe' : 'C:/Tools/agent.exe'
                    }
                  />
                </label>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={nodeMode}
                    onChange={(event) => setNodeMode(event.target.checked)}
                  />
                  使用 Node.js 启动已安装脚本
                </label>
                {nodeMode && (
                  <label className={s.field}>
                    ACP 脚本路径
                    <input
                      required
                      value={script}
                      onChange={(event) => setScript(event.target.value)}
                      placeholder="C:/Tools/adapter/index.js"
                    />
                    <small>选择已安装包的启动脚本；不使用临时下载命令。</small>
                  </label>
                )}
                {!!suggestedArgs.length && (
                  <div className={s.notice}>
                    <p>产品目录建议的启动参数（请对照产品说明确认）：</p>
                    <pre className={s.configExample}>{suggestedArgs.join('\n')}</pre>
                    <button type="button" onClick={() => setArgs([...suggestedArgs])}>
                      填入这些参数
                    </button>
                    <p className={s.hint}>会替换下方可选参数，保留已选择的脚本路径。</p>
                  </div>
                )}
                <details className={s.details}>
                  <summary>可选启动参数</summary>
                  <AgentArguments value={args} onChange={setArgs} />
                  {nodeMode && (
                    <p className={s.hint}>已填写的脚本路径会自动放在这些参数前面，无需重复添加。</p>
                  )}
                </details>
                <button type="submit" className={s.primary}>
                  下一步，预览成员
                </button>
              </fieldset>
            </form>
          </details>
          <div className={s.actions}>
            {draftStatus !== 'empty' && (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  try {
                    clearProductEntryDraft(sessionStorage, selected.id);
                  } catch {
                    /* optional storage */
                  }
                  fill(defaultFields(selected));
                  setRestored(false);
                  setDraftStatus('empty');
                }}
              >
                清除此产品的入口草稿
              </button>
            )}
            <button
              type="button"
              disabled={disabled || associating}
              onClick={() => {
                stopWaiting();
                setSelected(undefined);
                setError('');
              }}
            >
              返回产品列表
            </button>
            <button type="button" disabled={disabled || associating} onClick={onPaste}>
              改用命令或批量配置
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.actions}>
        <button type="button" disabled={disabled || associating} onClick={onCancel}>
          {cancelLabel ?? '取消接入'}
        </button>
      </div>
    </section>
  );
}
