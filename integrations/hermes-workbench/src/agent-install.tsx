import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Download, LoaderCircle, RefreshCw, ArrowRight } from 'lucide-react';
import s from './agent-connections.module.css';
import { AgentMemberCreate } from './agent-member-create';
import { SnapshotRefresh } from './snapshot-refresh';
const Plan = z.object({
  entryId: z.string(),
  name: z.string(),
  version: z.string(),
  planHash: z.string(),
  source: z.string(),
  integrity: z.string(),
});
const Installation = z.object({
  id: z.string(),
  entryId: z.string(),
  version: z.string(),
  state: z.enum([
    'queued',
    'downloading',
    'installing',
    'checking',
    'ready',
    'failed',
    'needs-attention',
  ]),
  message: z.string(),
  agentId: z.string().optional(),
  updatedAt: z.string(),
  installed: z.boolean().default(false),
  members: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  package: z
    .object({ runtime: z.object({ command: z.string(), args: z.array(z.string()) }) })
    .optional(),
});
const Records = z.object({ installations: z.array(Installation), busy: z.boolean() });
async function api<S extends z.ZodTypeAny>(
  url: string,
  schema: S,
  body?: unknown,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '安装操作未完成，请重试。');
  return schema.parse(data);
}
const labels = {
  queued: '准备安装',
  downloading: '下载中',
  installing: '安装中',
  checking: '检查连接',
  ready: '已安装',
  failed: '安装未完成',
  'needs-attention': '连接待处理',
};
export function AgentInstall({
  entryId,
  onExisting,
}: {
  entryId?: string;
  onExisting: (id?: string) => void;
}) {
  const [plan, setPlan] = useState<z.infer<typeof Plan>>();
  const [records, setRecords] = useState<z.infer<typeof Records>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const idempotency = useRef({ hash: '', id: crypto.randomUUID() });
  useEffect(() => {
    const reader = new SnapshotRefresh(
      (signal) => api('/api/agent-installations', Records, undefined, signal),
      (value) => {
        setRecords(value);
        setRecordsError('');
      },
      (failure) => setRecordsError(failure instanceof Error ? failure.message : '安装记录读取失败'),
      15000,
      '读取安装记录超时，稍后自动重试。',
    );
    void reader.refresh();
    const timer = window.setInterval(() => void reader.refresh(), 2000);
    return () => {
      reader.dispose();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setPlan(undefined);
    setError('');
    setChecking(!!entryId);
    if (!entryId) return;
    const controller = new AbortController();
    let active = true;
    void api(
      '/api/agent-catalog/' + encodeURIComponent(entryId) + '/install-plan',
      Plan,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [entryId]);
  async function start() {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      if (idempotency.current.hash !== plan.planHash)
        idempotency.current = { hash: plan.planHash, id: crypto.randomUUID() };
      await api('/api/agent-installations', Installation, {
        entryId: plan.entryId,
        version: plan.version,
        planHash: plan.planHash,
        requestId: idempotency.current.id,
        confirmed: true,
      });
      setRecords(await api('/api/agent-installations', Records));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '安装尚未确认，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setBusy(true);
    setError('');
    try {
      await api('/api/agent-installations/' + id + '/retry', Installation, {});
      setRecords(await api('/api/agent-installations', Records));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '重试未完成。');
    } finally {
      setBusy(false);
    }
  }
  const visible = records?.installations.filter((row) => !entryId || row.entryId === entryId) ?? [];
  const installed = visible.find((row) => row.installed && row.version === plan?.version);
  return (
    <section className={s.installPanel} aria-label="安装 ACP 成员">
      <h4>
        <Download size={16} /> {entryId ? '安装并接入' : '成员安装进度'}
      </h4>
      {!entryId && !visible.length && (
        <p role="status">
          {records ? '还没有下载记录。回到产品目录，选择 ACP 后下载安装。' : '正在读取安装记录…'}
        </p>
      )}
      {recordsError && (
        <p role="alert" className={s.error}>
          无法读取安装记录：{recordsError}。正在自动重试。
        </p>
      )}
      {checking && <p role="status">正在核对本平台安装方式…</p>}
      {plan && !installed && (
        <>
          <p className={s.hint}>
            固定版本 {plan.version} · 安装到工作台私有目录，自动填写入口。不会安装到全局。
          </p>
          <details>
            <summary>安装来源与验证方式</summary>
            <p className={s.configExample}>{plan.source}</p>
            <p className={s.hint}>
              {plan.integrity === 'sha256'
                ? '按目录提供的 SHA-256 校验。'
                : plan.integrity === 'npm-integrity'
                  ? 'npm 校验包完整性；安装脚本禁用。'
                  : '目录未提供校验和：使用 HTTPS 官方目录下载地址。'}
            </p>
          </details>
          <p className={s.hint}>
            安装后仅检查 ACP
            连接，不发送模型提示。账号由此成员自己的登录入口授权；原有审批和项目权限不变。
          </p>
          <button
            className={s.installPrimary}
            disabled={busy || !!records?.busy}
            onClick={() => void start()}
          >
            <Download size={15} />
            {busy ? '正在提交…' : records?.busy ? '有成员正在安装' : '确认安装并接入'}
          </button>
        </>
      )}
      {visible.map((row) => (
        <article className={s.installJob} key={row.id}>
          <div>
            <strong>
              {row.entryId} · {row.version}
            </strong>
            <span>{labels[row.state]}</span>
          </div>
          <p role={['failed', 'needs-attention'].includes(row.state) ? 'alert' : 'status'}>
            {['queued', 'downloading', 'installing', 'checking'].includes(row.state) && (
              <LoaderCircle size={14} />
            )}{' '}
            {row.message}
          </p>
          {row.package && (
            <details>
              <summary>本机安装入口</summary>
              <pre className={s.configExample}>
                {[row.package.runtime.command, ...row.package.runtime.args].join('\n')}
              </pre>
            </details>
          )}
          <div className={s.actions}>
            {['failed', 'needs-attention'].includes(row.state) && (
              <button disabled={busy || !!records?.busy} onClick={() => void retry(row.id)}>
                <RefreshCw size={14} />
                {row.state === 'needs-attention' ? '重试连接' : '重试安装'}
              </button>
            )}
            {row.members.map((member) => (
              <button key={member.id} onClick={() => onExisting(member.id)}>
                <ArrowRight size={14} />
                {member.name} · 打开成员
              </button>
            ))}
            {row.installed && (
              <AgentMemberCreate
                endpoint={'/api/agent-installations/' + row.id + '/members'}
                defaultName={(plan?.name ?? row.entryId) + ' · 新成员'}
                disabled={busy || !!records?.busy}
                onCreated={(id) => onExisting(id)}
              />
            )}
          </div>
        </article>
      ))}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
