import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight, Network } from 'lucide-react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import {
  NetworkSettingsView,
  NetworkTestResult,
  networkDraft,
  proxyAddress,
  networkSummary,
  draftChoice,
  networkPayload,
  sameNetworkDraft,
  networkTestSignature,
  type NetworkViewData,
  type NetworkDraft,
  type MemberChoice,
  type GlobalChoice,
} from './network-settings-model';
import s from './system-settings.module.css';

const Members = z.array(z.object({ definition: z.object({ id: z.string(), name: z.string() }) }));
const errorText = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError'
    ? '请求超时，草稿仍保留，可重新核对。'
    : '操作尚未确认，请检查地址和设置版本；草稿仍保留。';
type TestResult = z.infer<typeof NetworkTestResult>;
export function SystemSettings(props: {
  initialMemberId?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  return createPortal(<NetworkSettingsDialog {...props} />, document.body);
}
function NetworkSettingsDialog({
  initialMemberId,
  onClose,
  onSaved,
}: {
  initialMemberId?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    controller = useRef<AbortController | undefined>(undefined);
  const [saved, setSaved] = useState<NetworkViewData>(),
    [draft, setDraft] = useState<NetworkDraft>(),
    [members, setMembers] = useState<z.infer<typeof Members>>([]);
  const [latest, setLatest] = useState<NetworkViewData>();
  const [errorKey, setErrorKey] = useState<string>();
  const conflict = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<string | null>('load'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [discard, setDiscard] = useState(false);
  const [tests, setTests] = useState<
    Record<string, { signature: string | null; value: TestResult }>
  >({});
  const changed =
    !!saved && !!draft && JSON.stringify(networkDraft(saved)) !== JSON.stringify(draft);
  async function run<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    done: (value: T) => void,
  ) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(key);
    setError('');
    setErrorKey(undefined);
    const timer = window.setTimeout(() => request.abort(), 15000);
    try {
      const value = await work(request.signal);
      if (!request.signal.aborted) done(value);
    } catch (cause) {
      if (controller.current === request) {
        setError(errorText(cause));
        setErrorKey(key);
      }
    } finally {
      window.clearTimeout(timer);
      if (controller.current === request) {
        controller.current = undefined;
        setBusy(null);
      }
    }
  }
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current!.showModal();
    void run(
      'load',
      async (signal) =>
        Promise.all([
          fetchJSON('/api/system/network', { signal }, NetworkSettingsView),
          fetchJSON('/api/agents', { signal }, Members),
        ]),
      ([settings, list]) => {
        setSaved(settings);
        setDraft(networkDraft(settings));
        setMembers(list);
      },
    );
    return () => {
      controller.current?.abort();
      controller.current = undefined;
      dialog.current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!draft || !initialMemberId) return;
    document
      .getElementById(`network-member-${initialMemberId}`)
      ?.scrollIntoView({ block: 'center' });
  }, [!!draft, initialMemberId]);
  useEffect(() => {
    if (latest) {
      conflict.current?.scrollIntoView({ block: 'nearest' });
      conflict.current?.focus({ preventScroll: true });
    }
  }, [latest?.revision]);
  const close = () => {
    if (busy === 'save') return;
    if (changed) setDiscard(true);
    else onClose();
  };
  function change(choice: GlobalChoice | MemberChoice, id?: string) {
    if (!draft) return;
    setNotice('');
    setDraft(
      id
        ? { ...draft, members: { ...draft.members, [id]: choice as MemberChoice } }
        : { ...draft, global: choice as GlobalChoice },
    );
  }
  async function save(expectedRevision = saved?.revision) {
    if (!saved || !draft || busy) return;
    let value;
    try {
      value = networkPayload(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请核对地址。');
      setErrorKey('validation');
      dialog.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
      return;
    }
    await run(
      'save',
      (signal) =>
        fetchJSON(
          '/api/system/network',
          {
            method: 'PATCH',
            signal,
            body: JSON.stringify({ expectedRevision, ...value }),
          },
          NetworkSettingsView,
        ),
      (next) => {
        setSaved(next);
        setDraft(networkDraft(next));
        setLatest(undefined);
        setNotice('已保存。工作台后续联网采用新设置；成员在下次启动时使用，当前执行保持原样。');
        onSaved?.();
      },
    );
  }
  async function test(id?: string) {
    if (!draft || busy) return;
    let choice = draftChoice(draft, id);
    if (choice.mode === 'proxy') {
      const url = proxyAddress(choice.proxyUrl ?? '');
      if (!url) {
        setError('请填写有效 HTTP/HTTPS 地址；不要包含用户名或密码。');
        return;
      }
      choice = { ...choice, proxyUrl: url };
    }
    const signature = networkTestSignature(draftChoice(draft, id));
    await run(
      'test:' + (id ?? 'global'),
      (signal) =>
        fetchJSON(
          '/api/system/network/test',
          {
            method: 'POST',
            signal,
            body: JSON.stringify({ choice, ...(id ? { agentId: id } : {}) }),
          },
          NetworkTestResult,
        ),
      (value) => setTests((previous) => ({ ...previous, [id ?? 'global']: { signature, value } })),
    );
  }
  function result(id?: string) {
    if (!draft) return null;
    const item = tests[id ?? 'global'];
    if (!item) return <span className={s.muted}>尚未测试</span>;
    if (item.signature !== networkTestSignature(draftChoice(draft, id)))
      return <span className={s.muted}>配置已变化，需重新测试</span>;
    return (
      <div role="status" className={s.testResult} data-state={item.value.result}>
        <strong>{item.value.result === 'passed' ? '目标网络可达' : '检查未通过'}</strong>
        {item.value.result === 'failed' && <span>{item.value.message}</span>}
        {item.value.result === 'passed' && item.value.routeStatus === 'proxy-observed' && (
          <span>已确认经过所选本机代理</span>
        )}
        <small>
          {new Date(item.value.observedAt).toLocaleTimeString('zh-CN')} · {item.value.durationMs} ms
          · 未发送模型提示
        </small>
        {item.value.result === 'passed' && (
          <details>
            <summary>检查详情</summary>
            <span>{item.value.message}</span>
          </details>
        )}
      </div>
    );
  }
  function verifySaved() {
    return run(
      'refresh',
      (signal) =>
        Promise.all([
          fetchJSON('/api/system/network', { signal }, NetworkSettingsView),
          fetchJSON('/api/agents', { signal }, Members),
        ]),
      ([next, list]) => {
        setMembers(list);
        if (!draft) {
          setSaved(next);
          setDraft(networkDraft(next));
          return;
        }
        if (sameNetworkDraft(draft, networkDraft(next))) {
          setSaved(next);
          setDraft(networkDraft(next));
          setNotice('已核对，当前草稿已保存在服务端。');
          setLatest(undefined);
          onSaved?.();
        } else {
          setNotice(`服务端当前版本为 ${next.revision}。本地草稿保留，请核对下面的差异后选择。`);
          setLatest(next);
        }
      },
    );
  }
  function editor(choice: GlobalChoice | MemberChoice, id?: string) {
    return (
      <>
        <label className={id ? s.memberMode : s.field}>
          <span>连接方式</span>
          <select
            value={choice.mode}
            disabled={!!busy}
            onChange={(event) =>
              change({ ...choice, mode: event.target.value } as GlobalChoice | MemberChoice, id)
            }
          >
            <option value={id ? 'inherit' : 'unmanaged'}>{id ? '跟随全局' : '保留原有设置'}</option>
            <option value="direct">直接连接</option>
            <option value="proxy">{id ? '单独设置代理' : '使用代理'}</option>
          </select>
        </label>
        {choice.mode === 'proxy' && (
          <label className={s.field}>
            <span>代理地址</span>
            <input
              type="text"
              inputMode="url"
              aria-invalid={!proxyAddress(choice.proxyUrl ?? '')}
              value={choice.proxyUrl ?? ''}
              disabled={!!busy}
              placeholder="http://127.0.0.1:7897"
              onChange={(event) => change({ ...choice, proxyUrl: event.target.value }, id)}
            />
            <small>
              {proxyAddress(choice.proxyUrl ?? '')
                ? `采用 ${proxyAddress(choice.proxyUrl ?? '')}`
                : '支持 HTTP / HTTPS；请输入地址和端口'}
            </small>
          </label>
        )}
        {(id || choice.mode !== 'unmanaged') && (
          <p className={s.effective}>
            <ArrowRight size={13} /> {draft && networkSummary(draftChoice(draft, id))}
            {id && choice.mode === 'inherit' ? ' · 来自全局设置' : ''}
          </p>
        )}
        {choice.mode === 'proxy' && (
          <details className={s.advanced}>
            <summary>不使用代理的地址</summary>
            <p>本机工作台、MCP 与预览始终直连。</p>
            <label className={s.field}>
              <span>额外绕过地址（逗号分隔）</span>
              <input
                value={choice.bypass.join(', ')}
                disabled={!!busy}
                placeholder=".example.com, intranet.example"
                onChange={(event) =>
                  change(
                    { ...choice, bypass: event.target.value.split(',').map((v) => v.trim()) },
                    id,
                  )
                }
              />
            </label>
            <small>支持主机名、域名后缀与 IP；不支持 PAC、通配符和 CIDR。</small>
          </details>
        )}
        {choice.mode !== 'inherit' && choice.mode !== 'unmanaged' && (
          <div className={s.testLine}>
            <button type="button" disabled={!!busy} onClick={() => void test(id)}>
              {busy === 'test:' + (id ?? 'global') ? '正在检查…' : '测试此连接'}
            </button>
            {result(id)}
          </div>
        )}
      </>
    );
  }
  return (
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-labelledby="system-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={s.header}>
        <div>
          <span>工作台设置</span>
          <h2 id="system-settings-title">系统设置</h2>
        </div>
        <button type="button" aria-label="关闭系统设置" disabled={busy === 'save'} onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className={s.layout}>
        <nav aria-label="系统设置分类">
          <span aria-current="page">
            <Network size={16} /> 网络代理
          </span>
        </nav>
        <main className={s.content}>
          <h3>网络代理</h3>
          <p className={s.description}>
            设置工作台联网与各成员的连接方式。独立设置的成员不受全局代理变化影响。
          </p>
          {busy === 'load' && !draft && <p role="status">正在读取当前设置…</p>}
          {draft && (
            <>
              <section className={s.global} aria-label="全局网络设置">
                <div className={s.sectionTitle}>
                  <h4>全局连接方式</h4>
                  <span>默认规则</span>
                </div>
                {editor(draft.global)}
                {draft.global.mode === 'proxy' && (
                  <p className={s.muted}>
                    代理认证凭据暂不支持保存；可使用本机代理客户端的 HTTP 入口。不会修改 Windows
                    或宿主客户端代理。
                  </p>
                )}
              </section>
              <section aria-label="成员独立代理">
                <div className={s.sectionTitle}>
                  <h4>成员连接方式</h4>
                  <span>
                    {
                      members.filter(
                        (m) =>
                          !draft.members[m.definition.id] ||
                          draft.members[m.definition.id].mode === 'inherit',
                      ).length
                    }{' '}
                    位跟随全局
                  </span>
                </div>
                <label className={s.search}>
                  <span>搜索成员</span>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="按成员名称查找"
                  />
                </label>
                {members
                  .filter((m) => m.definition.name.toLowerCase().includes(search.toLowerCase()))
                  .map(({ definition: member }) => (
                    <article
                      className={s.member}
                      id={`network-member-${member.id}`}
                      key={member.id}
                      data-highlight={initialMemberId === member.id}
                      aria-label={`${member.name} 网络设置`}
                    >
                      <h4>{member.name}</h4>
                      {editor(
                        draft.members[member.id] ?? { mode: 'inherit', bypass: [] },
                        member.id,
                      )}
                    </article>
                  ))}
                {!members.length && (
                  <p className={s.muted}>尚未接入成员；接入后默认跟随全局规则。</p>
                )}
              </section>
            </>
          )}
          {notice && (
            <p role="status" className={s.notice}>
              {notice}
            </p>
          )}
          {latest && draft && (
            <section
              ref={conflict}
              tabIndex={-1}
              className={s.notice}
              aria-label="网络设置版本变化"
            >
              <h4>服务端版本 {latest.revision} · 草稿已保留</h4>
              <p>
                全局：我的草稿 {networkSummary(draft.global)} / 已保存{' '}
                {networkSummary(latest.global)}
              </p>
              <p>
                绕过地址：我的草稿 {draft.global.bypass.join(', ') || '仅本机'} / 已保存{' '}
                {latest.global.bypass.join(', ') || '仅本机'}
              </p>
              {members
                .filter(
                  ({ definition: m }) =>
                    JSON.stringify(draft.members[m.id]) !== JSON.stringify(latest.members[m.id]),
                )
                .map(({ definition: m }) => (
                  <p key={m.id}>
                    {m.name}：我的草稿{' '}
                    {draft.members[m.id]?.mode === 'inherit' || !draft.members[m.id]
                      ? '跟随全局 · '
                      : ''}
                    {networkSummary(draftChoice(draft, m.id))} / 已保存{' '}
                    {latest.members[m.id]?.mode === 'inherit' || !latest.members[m.id]
                      ? '跟随全局 · '
                      : ''}
                    {networkSummary(draftChoice(networkDraft(latest), m.id))}
                  </p>
                ))}
              <div className={s.testLine}>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setSaved(latest);
                    setDraft(networkDraft(latest));
                    setLatest(undefined);
                    setError('');
                    setNotice('已载入最新设置。');
                  }}
                >
                  载入最新并替换草稿
                </button>
                <button type="button" disabled={!!busy} onClick={() => void save(latest.revision)}>
                  使用我的草稿重新保存
                </button>
              </div>
            </section>
          )}
        </main>
      </div>
      {discard ? (
        <footer className={s.footer}>
          <span>有尚未保存的修改</span>
          <button type="button" onClick={() => setDiscard(false)}>
            继续编辑
          </button>
          <button type="button" onClick={onClose}>
            放弃修改并关闭
          </button>
        </footer>
      ) : (
        <footer className={s.footer}>
          {error && (
            <div className={s.feedback}>
              <span role="alert">{error}</span>
              {['load', 'refresh', 'save'].includes(errorKey ?? '') && (
                <button type="button" disabled={!!busy} onClick={() => void verifySaved()}>
                  {errorKey === 'save' ? '核对保存结果' : '重新读取设置'}
                </button>
              )}
            </div>
          )}
          <span>
            {busy === 'save'
              ? '正在保存…'
              : busy === 'refresh'
                ? '正在核对…'
                : changed
                  ? '有尚未保存的修改'
                  : '当前设置已保存'}
          </span>
          <button
            type="button"
            disabled={!!busy || !!latest || !saved || !changed}
            onClick={() => {
              if (saved) {
                setDraft(networkDraft(saved));
                setError('');
                setNotice('');
              }
            }}
          >
            还原修改
          </button>
          <button
            type="button"
            className={s.primary}
            disabled={!!busy || !!latest || !draft || !changed}
            onClick={() => void save()}
          >
            保存设置
          </button>
        </footer>
      )}
    </dialog>
  );
}
