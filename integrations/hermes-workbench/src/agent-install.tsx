import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import s from './agent-connections.module.css';
import { AgentMemberCreate } from './agent-member-create';
import { SnapshotRefresh } from './snapshot-refresh';
import { AgentInstallMember, InstalledMember } from './agent-install-member';
import { AgentPackageMaintenance } from './agent-package-maintenance';
const Plan = z.object({
  entryId: z.string(),
  name: z.string(),
  version: z.string(),
  planHash: z.string(),
  source: z.string(),
  integrity: z.string(),
  runtime: z.string().optional(),
  installationRoot: z.string().optional(),
  runtimeDirectory: z.string().optional(),
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
    'cancelled',
    'needs-attention',
    'removing',
    'removal-failed',
    'uninstalled',
  ]),
  message: z.string(),
  agentId: z.string().optional(),
  updatedAt: z.string(),
  directory: z.string().optional(),
  progress: z
    .object({
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().positive().optional(),
    })
    .optional(),
  installed: z.boolean().default(false),
  canCancel: z.boolean().default(false),
  cancelling: z.boolean().default(false),
  members: z.array(InstalledMember).default([]),
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
  cancelled: '已取消',
  'needs-attention': '连接待处理',
  removing: '卸载中',
  'removal-failed': '卸载未完成',
  uninstalled: '已卸载',
};
function InstallLocation({ label, directory }: { label: string; directory: string }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className={s.installLocation}>
      <label>
        {label}
        <textarea
          aria-label={label}
          readOnly
          rows={2}
          value={directory}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(directory).then(
            () => setFeedback('已复制'),
            () => setFeedback('复制未完成，请选中路径后按 Ctrl+C'),
          );
          if (!navigator.clipboard) setFeedback('请选中路径后按 Ctrl+C');
        }}
      >
        复制{label}
      </button>
      <span role="status">{feedback}</span>
    </div>
  );
}
function bytes(value: number) {
  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function InstallProgress({ row }: { row: z.infer<typeof Installation> }) {
  const [now, setNow] = useState(Date.now());
  const active = ['queued', 'downloading', 'installing', 'checking'].includes(row.state);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const progress = row.progress;
  const total = progress?.totalBytes;
  const percent = total
    ? Math.min(100, Math.floor((progress!.receivedBytes / total) * 100))
    : undefined;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(row.updatedAt)) / 1000));
  return (
    <div className={s.installProgress}>
      <div
        className={s.installProgressTrack}
        role="progressbar"
        aria-label="当前步骤进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={
          row.cancelling
            ? '正在取消，等待后台停止'
            : percent === undefined
              ? '正在处理，总进度未知'
              : `已下载 ${percent}%`
        }
        data-indeterminate={percent === undefined}
      >
        <span style={{ width: percent === undefined ? '35%' : `${percent}%` }} />
      </div>
      <p role="status">
        {row.cancelling
          ? '正在取消，等待下载或安装进程停止…'
          : progress
            ? total
              ? `已下载 ${bytes(progress.receivedBytes)} / ${bytes(total)}（${percent}%）`
              : `已下载 ${bytes(progress.receivedBytes)} · 总大小未知`
            : '正在处理，请稍候'}
        {' · '}当前步骤已用 {elapsed} 秒
      </p>
      <p className={s.hint}>下载 → 安装 → 检查连接。完成后再登录使用；关闭此窗口不影响后台安装。</p>
    </div>
  );
}
export function AgentInstall({
  entryId,
  onExisting,
  onUse,
  onBusy,
  installRequested = false,
  expectedVersion,
  disabled = false,
  activeOnly = false,
}: {
  entryId?: string;
  onExisting: (id?: string) => void;
  onUse: (id: string) => void;
  onBusy: (busy: boolean) => void;
  installRequested?: boolean;
  expectedVersion?: string;
  disabled?: boolean;
  activeOnly?: boolean;
}) {
  const [plan, setPlan] = useState<z.infer<typeof Plan>>();
  const [records, setRecords] = useState<z.infer<typeof Records>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [cancellationId, setCancellationId] = useState('');
  const idempotency = useRef({ hash: '', id: crypto.randomUUID() });
  const autoAttempted = useRef(false),
    flight = useRef(false);
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
    if (!plan || flight.current) return;
    flight.current = true;
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
      flight.current = false;
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
  async function cancel(id: string) {
    setBusy(true);
    setError('');
    try {
      await api('/api/agent-installations/' + id + '/cancel', Installation, {});
      setCancellationId(id);
      setRecords(await api('/api/agent-installations', Records));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '取消未确认，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const visible =
    records?.installations.filter(
      (row) =>
        (!entryId || row.entryId === entryId) &&
        (!activeOnly ||
          ['queued', 'downloading', 'installing', 'checking'].includes(row.state) ||
          row.id === cancellationId),
    ) ?? [];
  const installed = visible.find((row) => row.installed && row.version === plan?.version);
  useEffect(() => {
    if (!installRequested || autoAttempted.current || !plan || !records) return;
    autoAttempted.current = true;
    if (expectedVersion && plan.version !== expectedVersion) {
      setError('目录版本已变化，请核对新版本后再点击安装。');
      return;
    }
    if (!installed && !records.busy) void start();
  }, [installRequested, plan, records, installed]);
  if (activeOnly && !visible.length && !recordsError && !error) return null;
  return (
    <section className={s.installPanel} aria-label="安装 ACP 成员">
      <h4>
        <Download size={16} /> {entryId ? '安装 → 登录 → 使用' : '成员安装进度'}
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
      {plan && !installed && !visible.some((row) => row.version === plan.version) && (
        <>
          <p className={s.hint}>
            {plan.runtime ?? '自动准备运行环境'} · 版本 {plan.version} ·
            安装到工作台私有目录，无需填写路径。
          </p>
          {plan.installationRoot && (
            <InstallLocation label="程序下载目录" directory={plan.installationRoot} />
          )}
          {plan.runtimeDirectory && plan.runtime?.startsWith('Python') && (
            <InstallLocation label="共享运行环境目录" directory={plan.runtimeDirectory} />
          )}
          <details>
            <summary>安装来源与验证方式</summary>
            <p className={s.configExample}>{plan.source}</p>
            <p className={s.hint}>
              {plan.integrity === 'sha256'
                ? '按目录提供的 SHA-256 校验。'
                : plan.integrity === 'pypi-integrity'
                  ? '通过 uv 安装固定版本 Python 包，使用私有 Python 环境。'
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
            disabled={disabled || busy || !!records?.busy}
            onClick={() => void start()}
          >
            <Download size={15} />
            {busy ? '正在提交…' : records?.busy ? '有成员正在安装' : '安装并接入'}
          </button>
        </>
      )}
      {visible.map((row) => (
        <article className={s.installJob} key={row.id}>
          <div>
            <strong>
              {row.entryId} · {row.version}
            </strong>
            <span>{row.cancelling ? '正在取消' : labels[row.state]}</span>
          </div>
          <p role={['failed', 'needs-attention'].includes(row.state) ? 'alert' : 'status'}>
            {['queued', 'downloading', 'installing', 'checking'].includes(row.state) && (
              <LoaderCircle size={14} />
            )}{' '}
            {row.message}
          </p>
          <InstallProgress row={row} />
          {row.canCancel && (
            <button
              type="button"
              disabled={disabled || busy || row.cancelling}
              onClick={() => void cancel(row.id)}
            >
              {row.cancelling ? '正在取消…' : '取消下载 / 安装'}
            </button>
          )}
          {row.directory ? (
            <InstallLocation label="本次安装位置" directory={row.directory} />
          ) : (
            <p className={s.hint}>旧版记录未保存安装目录，可展开下方入口查看程序路径。</p>
          )}
          {row.package && (
            <details>
              <summary>本机安装入口</summary>
              <pre className={s.configExample}>
                {[row.package.runtime.command, ...row.package.runtime.args].join('\n')}
              </pre>
            </details>
          )}
          <div className={s.actions}>
            {(row.state === 'uninstalled' ||
              (['ready', 'failed', 'needs-attention'].includes(row.state) && !row.installed)) &&
              plan && (
                <button
                  disabled={disabled || busy || !!records?.busy}
                  onClick={() => {
                    idempotency.current = { hash: plan.planHash, id: crypto.randomUUID() };
                    void start();
                  }}
                >
                  重新安装
                </button>
              )}
            {['failed', 'cancelled', 'needs-attention'].includes(row.state) && (
              <button
                disabled={disabled || busy || !!records?.busy}
                onClick={() => void retry(row.id)}
              >
                <RefreshCw size={14} />
                {row.state === 'needs-attention'
                  ? '重试连接'
                  : row.state === 'cancelled'
                    ? '重新安装'
                    : '重试安装'}
              </button>
            )}
            {row.members.map((member) =>
              row.installed ? (
                <AgentInstallMember
                  key={member.id}
                  member={member}
                  onUse={onUse}
                  onExisting={onExisting}
                  disabled={disabled}
                />
              ) : (
                <section className={s.installMember} key={member.id}>
                  <strong>{member.name}</strong>
                  <p>成员配置已保留。程序不可用，请重新安装或在成员详情中配置已有入口。</p>
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => onExisting(member.id)}
                  >
                    成员详情
                  </button>
                </section>
              ),
            )}
            {row.installed && (
              <details>
                <summary>更多成员选项</summary>
                <AgentMemberCreate
                  endpoint={'/api/agent-installations/' + row.id + '/members'}
                  defaultName={(plan?.name ?? row.entryId) + ' · 新成员'}
                  disabled={disabled || busy || !!records?.busy}
                  onCreated={(id) => onExisting(id)}
                />
              </details>
            )}
          </div>
          {row.directory && !activeOnly && (
            <AgentPackageMaintenance
              id={row.id}
              disabled={disabled || busy || !!records?.busy}
              uninstalled={row.state === 'uninstalled'}
              onBusy={onBusy}
              onChanged={async () => setRecords(await api('/api/agent-installations', Records))}
            />
          )}
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
