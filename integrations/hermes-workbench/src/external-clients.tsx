import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import {
  Cable,
  Check,
  Copy,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import s from './external-clients.module.css';

const Target = z.enum(['codex', 'cursor', 'vscode', 'idea', 'generic']);
const Project = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  workspaceConfirmation: z
    .object({ workspaceId: z.string(), rootPath: z.string(), version: z.string() })
    .optional(),
});
const Client = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  projectIds: z.array(z.string()),
  target: Target,
  profile: z.string(),
  configuredAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  managed: z.boolean(),
  connectionAvailable: z.boolean(),
});
const View = z.object({ projects: z.array(Project), clients: z.array(Client) });
const Configuration = z.object({
  id: z.string(),
  name: z.string(),
  target: Target,
  config: z.string(),
  installUrl: z.string().optional(),
  codexInstallAvailable: z.boolean(),
});
type Config = z.infer<typeof Configuration>;
async function request<T>(url: string, schema: z.ZodType<T>, body?: unknown) {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(25_000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(typeof value.error === 'string' ? value.error : '操作未完成，请重试。');
  return schema.parse(value);
}
const labels = {
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  idea: 'IDEA / JetBrains',
  generic: '其他 MCP 客户端',
};
export function ExternalClients({
  projectId,
  onClose,
}: {
  projectId?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<z.infer<typeof View>>();
  const [project, setProject] = useState(projectId ?? '');
  const [target, setTarget] = useState<z.infer<typeof Target>>('codex');
  const [profile, setProfile] = useState('collaborate');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Config>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const key = useRef({ payload: '', id: crypto.randomUUID() });
  async function load() {
    const next = await request('/api/external-clients', View);
    setView(next);
    setProject((current) =>
      next.projects.some((p) => p.id === current) ? current : (next.projects[0]?.id ?? ''),
    );
  }
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未完成，请重试。');
    } finally {
      setBusy('');
    }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void run('load', load);
  }, []);
  // Actual gateway use, rather than clicking an install link, confirms a connection.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy) void load().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [busy]);
  const selected = view?.projects.find((p) => p.id === project);
  const active = view?.clients.find((c) => c.id === config?.id);
  function create() {
    if (config) {
      setConfig(undefined);
      key.current = { payload: '', id: crypto.randomUUID() };
      setNotice('请选择新接入的项目与应用，确认后再生成。');
      return;
    }
    if (!selected) return;
    return run('create', async () => {
      const payload = {
        projectId: project,
        target,
        profile,
        name: name.trim() || labels[target],
        workspaceConfirmation: selected.workspaceConfirmation,
      };
      const serialized = JSON.stringify(payload);
      if (key.current.payload !== serialized)
        key.current = { payload: serialized, id: crypto.randomUUID() };
      setConfig(
        await request('/api/external-clients', Configuration, {
          ...payload,
          requestId: key.current.id,
        }),
      );
      await load();
      setNotice('授权与配置已生成。接着安装到客户端，首次调用后会在这里显示连接记录。');
    });
  }
  return createPortal(
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-labelledby="external-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>共享本地协作能力</span>
          <h2 id="external-title">
            <Cable size={22} /> 接入应用
          </h2>
          <p>在熟悉的客户端发任务，在这里同步过程、文件和预览。</p>
        </div>
        <button aria-label="关闭应用接入" disabled={!!busy} onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className={s.layout}>
        <section className={s.setup} aria-label="创建应用接入">
          <ol className={s.steps}>
            <li data-active={!config}>1 选择项目</li>
            <li data-active={!!config}>2 安装到应用</li>
            <li>3 开始协作</li>
          </ol>
          <label>
            项目
            <select
              value={project}
              disabled={!!busy}
              onChange={(e) => {
                setProject(e.target.value);
                setConfig(undefined);
              }}
            >
              {!view?.projects.length && <option value="">暂无可接入项目</option>}
              {view?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {selected && <p className={s.path}>{selected.rootPath}</p>}
          {view && !view.projects.length && <p>先在工作台创建或选择一个项目，再来接入。</p>}
          <label>
            使用的应用
            <select
              value={target}
              disabled={!!busy}
              onChange={(e) => {
                setTarget(Target.parse(e.target.value));
                setConfig(undefined);
              }}
            >
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            接入名称 <span className={s.muted}>可选，用来区分多个客户端</span>
            <input
              value={name}
              maxLength={128}
              placeholder={labels[target]}
              disabled={!!busy}
              onChange={(e) => {
                setName(e.target.value);
                setConfig(undefined);
              }}
            />
          </label>
          <fieldset disabled={!!busy}>
            <legend>允许此应用做什么</legend>
            <label className={s.choice}>
              <input
                type="radio"
                name="external-profile"
                checked={profile === 'collaborate'}
                onChange={() => {
                  setProfile('collaborate');
                  setConfig(undefined);
                }}
              />
              <span>
                <strong>发任务与继续追问</strong>
                <small>共用成员、附件、任务记录，可准备变更审阅。</small>
              </span>
            </label>
            <label className={s.choice}>
              <input
                type="radio"
                name="external-profile"
                checked={profile === 'read'}
                onChange={() => {
                  setProfile('read');
                  setConfig(undefined);
                }}
              />
              <span>
                <strong>只查看</strong>
                <small>查看项目、成员、过程和结果。</small>
              </span>
            </label>
          </fieldset>
          <p className={s.policy}>
            <ShieldCheck size={17} />{' '}
            仅授权所选项目。沿用当前自动审批；需要确认的命令仍由你批准，代码合并仍由你审阅。
          </p>
          <button
            className={s.primary}
            disabled={!!busy || !selected}
            onClick={() => void create()}
          >
            <Plus size={16} />
            {busy === 'create' ? '正在生成…' : config ? '新建另一个接入' : '授权并生成接入'}
          </button>
          <p className={s.muted}>适用于本机客户端。MCP 接入授权与成员账号登录相互独立。</p>
        </section>
        <section className={s.result} aria-label="安装与接入记录">
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
          {config && active?.enabled && (
            <article className={s.config}>
              <h3>
                <Check size={18} /> 已生成 {labels[config.target]} 接入
              </h3>
              {config.target === 'codex' && config.codexInstallAvailable && (
                <button
                  className={s.primary}
                  disabled={!!busy}
                  onClick={() =>
                    void run('install', async () => {
                      const receipt = await request(
                        '/api/external-clients/' + config.id + '/install',
                        z.object({ message: z.string() }),
                        {},
                      );
                      setNotice(receipt.message);
                      await load();
                    })
                  }
                >
                  <Download size={16} />
                  {busy === 'install' ? '正在安装…' : '安装到 Codex'}
                </button>
              )}
              {config.target === 'codex' && (
                <p className={s.muted}>
                  安装会由 Codex 自己新增一个 MCP 项并保留原配置副本。完成后在 Codex
                  重连；不会改成员登录或模型设置。
                </p>
              )}
              {config.installUrl && (
                <a className={s.installLink} href={config.installUrl}>
                  <ExternalLink size={16} />在 {labels[config.target]} 中安装
                </a>
              )}
              {config.installUrl && (
                <p className={s.muted}>应用会打开安装确认。若未打开，可复制下方配置。</p>
              )}
              {config.target === 'idea' && (
                <p>在 IDEA 的 AI Assistant → MCP 中添加，粘贴下方完整配置并应用。</p>
              )}
              <div className={s.actions}>
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void run('copy', async () => {
                      await navigator.clipboard.writeText(config.config);
                      setNotice('完整配置已复制，可直接粘贴到本机客户端。');
                    })
                  }
                >
                  <Copy size={15} />
                  复制完整配置
                </button>
                <button
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([config.config], { type: 'application/json' }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = config.name + (config.target === 'codex' ? '.toml' : '.json');
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={15} />
                  下载配置
                </button>
              </div>
              <details>
                <summary>查看配置</summary>
                <textarea
                  aria-label="完整 MCP 配置"
                  readOnly
                  value={config.config}
                  onFocus={(e) => e.target.select()}
                />
              </details>
              <p className={s.muted}>
                客户端首次调用后，可直接发任务、带附件和追问。新 ACP
                的账号授权请在“协作成员”中通过成员自己的登录入口完成。
              </p>
            </article>
          )}
          <div className={s.listTitle}>
            <h3>已有接入</h3>
            <button
              aria-label="刷新接入状态"
              disabled={!!busy}
              onClick={() => void run('load', load)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {busy === 'load' && !view && <p role="status">正在读取接入…</p>}
          {view?.clients.length === 0 && (
            <div className={s.empty}>
              <Cable size={30} />
              <strong>把协作能力带到你的应用</strong>
              <p>选择项目并生成接入。每个应用可单独撤销，已有任务会保留。</p>
            </div>
          )}
          {view?.clients.map((client) => (
            <article className={s.client} key={client.id}>
              <div className={s.clientHeading}>
                <strong>{client.name}</strong>
                <span className={s.badge} data-active={client.enabled}>
                  {!client.enabled
                    ? '已撤销'
                    : client.lastUsedAt
                      ? '已有调用记录'
                      : client.configuredAt
                        ? '已安装 · 等待连接'
                        : '等待客户端连接'}
                </span>
              </div>
              <p>
                {client.projectIds
                  .map((id) => view.projects.find((p) => p.id === id)?.name ?? id)
                  .join('、')}{' '}
                · {client.profile === 'read' ? '只查看' : '任务与追问'}
              </p>
              {client.lastUsedAt && (
                <small>最近调用 {new Date(client.lastUsedAt).toLocaleString('zh-CN')}</small>
              )}
              {client.enabled && (
                <div className={s.actions}>
                  {client.managed && client.connectionAvailable && (
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void run('config', async () => {
                          setConfig(
                            await request(
                              '/api/external-clients/' + client.id + '/config',
                              Configuration,
                            ),
                          );
                        })
                      }
                    >
                      查看安装与配置
                    </button>
                  )}
                  <button
                    className={s.danger}
                    disabled={!!busy}
                    onClick={() => setRevokeId(client.id)}
                  >
                    撤销授权
                  </button>
                </div>
              )}
              {revokeId === client.id && (
                <div className={s.revoke}>
                  <p>撤销后此应用立即不能调用协作工具；已有任务、附件和改动保留。</p>
                  <button
                    className={s.danger}
                    disabled={!!busy}
                    onClick={() =>
                      void run('revoke', async () => {
                        await request(
                          '/api/external-clients/' + client.id + '/revoke',
                          z.object({ enabled: z.literal(false) }),
                          {},
                        );
                        setRevokeId('');
                        if (config?.id === client.id) setConfig(undefined);
                        key.current = { payload: '', id: crypto.randomUUID() };
                        await load();
                        setNotice('已撤销该应用授权，任务和附件保留。');
                      })
                    }
                  >
                    确认撤销此接入
                  </button>
                  <button disabled={!!busy} onClick={() => setRevokeId('')}>
                    保留授权
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
