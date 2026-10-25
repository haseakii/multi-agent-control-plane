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
  revision: z.number().default(0),
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
type ClientData = z.infer<typeof Client>;
type Config = z.infer<typeof Configuration>;
async function request<S extends z.ZodTypeAny>(
  url: string,
  schema: S,
  body?: unknown,
  method = 'POST',
): Promise<z.output<S>> {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
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
  const dialog = useRef<HTMLDialogElement>(null),
    initialized = useRef(false);
  const [view, setView] = useState<z.infer<typeof View>>();
  const [projects, setProjects] = useState<string[]>(projectId ? [projectId] : []);
  const [target, setTarget] = useState<z.infer<typeof Target>>('codex');
  const [profile, setProfile] = useState('collaborate');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<ClientData>();
  const [config, setConfig] = useState<Config>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const key = useRef({ payload: '', id: crypto.randomUUID() });
  async function load() {
    const next = await request('/api/external-clients', View);
    setView(next);
    if (!initialized.current) {
      initialized.current = true;
      setProjects((current) => {
        const valid = current.filter((id) => next.projects.some((p) => p.id === id));
        return valid.length ? valid : next.projects[0] ? [next.projects[0].id] : [];
      });
    }
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
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy) void load().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [busy]);
  const active = view?.clients.find((c) => c.id === config?.id),
    missing = projects.filter((id) => !view?.projects.some((p) => p.id === id));
  const stale =
    editing &&
    !!view?.clients.some(
      (c) => c.id === editing.id && (c.revision > editing.revision || !c.enabled),
    );
  function startNew() {
    setEditing(undefined);
    setConfig(undefined);
    setName('');
    setError('');
    setNotice('请选择应用和需要授权的项目。');
    key.current = { payload: '', id: crypto.randomUUID() };
  }
  function edit(client: ClientData) {
    setEditing(client);
    setConfig(undefined);
    setName(client.name);
    setTarget(client.target);
    setProfile(client.profile);
    setProjects(client.projectIds);
    setNotice('只更新此接入的项目与工具权限，现有客户端配置和凭据保持不变。');
    setError('');
    key.current = { payload: '', id: crypto.randomUUID() };
  }
  function clearConfig() {
    setConfig(undefined);
  }
  function submit() {
    if (config && !editing) {
      startNew();
      return;
    }
    return run('save', async () => {
      const grants = projects.map((id) => {
        const project = view?.projects.find((p) => p.id === id);
        if (!project) throw new Error('部分项目目录不可用，请先取消该项目或重新确认目录。');
        return {
          projectId: id,
          ...(project.workspaceConfirmation
            ? { workspaceConfirmation: project.workspaceConfirmation }
            : {}),
        };
      });
      const payload = editing
        ? { expectedRevision: editing.revision, projects: grants, profile }
        : { name: name.trim() || labels[target], target, profile, projects: grants };
      const serialized = JSON.stringify({ clientId: editing?.id, ...payload });
      if (key.current.payload !== serialized)
        key.current = { payload: serialized, id: crypto.randomUUID() };
      if (editing) {
        const receipt = await request(
          '/api/external-clients/' + editing.id + '/grants',
          z.object({ id: z.string(), revision: z.number() }),
          { ...payload, requestId: key.current.id },
          'PATCH',
        );
        const permissionChanged = editing.profile !== profile;
        setEditing({ ...editing, projectIds: projects, profile, revision: receipt.revision });
        await load();
        setNotice(
          '项目授权已保存，无需重新安装或修改客户端配置。' +
            (permissionChanged
              ? '工具权限已变化，若客户端仍显示旧工具，请刷新工具列表或重连。'
              : ''),
        );
      } else {
        setConfig(
          await request('/api/external-clients', Configuration, {
            ...payload,
            requestId: key.current.id,
          }),
        );
        await load();
        setNotice('授权与配置已生成。安装一次后，即可在授权项目间切换；首次调用后显示调用记录。');
      }
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
            <Cable size={22} />
            接入应用
          </h2>
          <p>接入一次，在多个已授权项目间发任务、带附件和继续追问。</p>
        </div>
        <button aria-label="关闭应用接入" disabled={!!busy} onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className={s.layout}>
        <section className={s.setup} aria-label={editing ? '管理项目授权' : '创建应用接入'}>
          <ol className={s.steps}>
            <li data-active={!config && !editing}>1 选择应用</li>
            <li data-active={!!editing}>2 授权项目</li>
            <li data-active={!!config}>3 安装使用</li>
          </ol>
          {editing && (
            <div className={s.editing}>
              <div className={s.editingHeading}>
                <strong title={editing.name}>管理 {editing.name}</strong>
                <button disabled={!!busy} onClick={startNew}>
                  新建接入
                </button>
              </div>
              <small>沿用现有连接，勾选下方项目。</small>
            </div>
          )}
          {!editing && (
            <>
              <label>
                使用的应用
                <select
                  value={target}
                  disabled={!!busy || !!editing}
                  onChange={(e) => {
                    setTarget(Target.parse(e.target.value));
                    clearConfig();
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
                接入名称 <span className={s.muted}>用于区分不同客户端</span>
                <input
                  value={name}
                  maxLength={128}
                  placeholder={labels[target]}
                  disabled={!!busy || !!editing}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearConfig();
                  }}
                />
              </label>
            </>
          )}
          <fieldset disabled={!!busy} className={s.projectField}>
            <legend>
              授权项目 <span className={s.muted}>已选 {projects.length} 项</span>
            </legend>
            <div className={s.projectList}>
              {view?.projects.map((project) => (
                <label className={s.projectChoice} key={project.id}>
                  <input
                    type="checkbox"
                    checked={projects.includes(project.id)}
                    onChange={(e) => {
                      setProjects((current) =>
                        e.target.checked
                          ? [...current, project.id]
                          : current.filter((id) => id !== project.id),
                      );
                      clearConfig();
                    }}
                  />
                  <span>
                    <strong title={project.name}>{project.name}</strong>
                    <small>{project.rootPath}</small>
                  </span>
                </label>
              ))}
              {missing.map((id) => (
                <label className={s.projectChoice} key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => setProjects((current) => current.filter((p) => p !== id))}
                  />
                  <span>
                    <strong>{id}</strong>
                    <small>目录暂不可用；取消勾选可移除此项目授权。</small>
                  </span>
                </label>
              ))}
            </div>
            {view && !view.projects.length && (
              <p className={s.muted}>先在工作台创建或选择项目，再来接入。</p>
            )}
          </fieldset>
          <fieldset disabled={!!busy}>
            <legend>允许此应用做什么</legend>
            <label className={s.choice}>
              <input
                type="radio"
                name="external-profile"
                checked={profile === 'collaborate'}
                onChange={() => {
                  setProfile('collaborate');
                  clearConfig();
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
                  clearConfig();
                }}
              />
              <span>
                <strong>只查看</strong>
                <small>仅展示查看工具，写操作仍由后台拒绝。</small>
              </span>
            </label>
          </fieldset>
          <p className={s.policy}>
            <ShieldCheck size={17} />
            仅对勾选项目生效。沿用当前自动审批；需要确认的命令与代码合并仍由你审阅。
          </p>
          {stale && (
            <p className={s.error} role="alert">
              授权已在其他位置更新，本地选择保留。
              <button
                disabled={!!busy}
                onClick={() => {
                  const latest = view?.clients.find((c) => c.id === editing.id);
                  if (latest) edit(latest);
                }}
              >
                重新读取此接入
              </button>
            </p>
          )}
          <div className={s.submitBox}>
            <button
              className={s.primary}
              disabled={!!busy || !projects.length || !!missing.length || !!stale}
              onClick={() => void submit()}
            >
              <Plus size={16} />
              {busy === 'save'
                ? '正在保存…'
                : editing
                  ? '保存项目授权'
                  : config
                    ? '新建另一个接入'
                    : '授权并生成接入'}
            </button>
            <p className={s.muted}>
              {editing
                ? '此操作不会新增 MCP 配置项。'
                : '适用于本机客户端。MCP 接入授权与成员账号登录独立。'}
            </p>
          </div>
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
                <Check size={18} />
                已生成 {labels[config.target]} 接入
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
                  {config.codexInstallAvailable
                    ? '安装会由 Codex 自己新增一个 MCP 项并保留原配置副本。完成后重连此 MCP。'
                    : '未发现已安装的 Codex CLI，可复制下面的 TOML 配置到客户端。'}
                </p>
              )}
              {config.installUrl && (
                <>
                  <a className={s.installLink} href={config.installUrl}>
                    <ExternalLink size={16} />在 {labels[config.target]} 中安装
                  </a>
                  <p className={s.muted}>应用会打开安装确认。若未打开，可复制完整配置。</p>
                </>
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
                      setNotice('完整配置已复制。以后增减项目使用“管理项目”，无需重新安装。');
                    })
                  }
                >
                  <Copy size={15} />
                  复制完整配置
                </button>
                <button
                  onClick={() => {
                    const url = URL.createObjectURL(
                        new Blob([config.config], { type: 'text/plain' }),
                      ),
                      link = document.createElement('a');
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
                在客户端选择授权项目，即可发任务、查看记录和继续追问。增加项目不会增加 MCP 配置项。
              </p>
            </article>
          )}
          <div className={s.listTitle}>
            <h3>
              有效接入{' '}
              {view ? view.clients.filter((client) => client.enabled).length + ' / 64' : ''}
            </h3>
            <button
              aria-label="刷新接入状态"
              disabled={!!busy}
              onClick={() => void run('load', load)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {busy === 'load' && !view && <p role="status">正在读取接入…</p>}
          {view?.clients.every((client) => !client.enabled) && (
            <div className={s.empty}>
              <Cable size={30} />
              <strong>把协作能力带到你的应用</strong>
              <p>选择应用并授权项目。每个应用可单独撤销，已有任务保留。</p>
            </div>
          )}
          {view?.clients
            .filter((client) => client.enabled)
            .map((client) => (
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
                  {client.projectIds.length} 个项目 ·{' '}
                  {client.profile === 'read' ? '只查看' : '任务与追问'}
                </p>
                <p>
                  {client.projectIds
                    .map((id) => view.projects.find((p) => p.id === id)?.name ?? id)
                    .join('、')}
                </p>
                {client.lastUsedAt && (
                  <small>最近调用 {new Date(client.lastUsedAt).toLocaleString('zh-CN')}</small>
                )}
                {client.enabled && (
                  <div className={s.actions}>
                    <button disabled={!!busy} onClick={() => edit(client)}>
                      管理项目
                    </button>
                    {client.managed && client.connectionAvailable && (
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void run('config', async () => {
                            const next = await request(
                              '/api/external-clients/' + client.id + '/config',
                              Configuration,
                            );
                            setEditing(undefined);
                            setName(client.name);
                            setTarget(client.target);
                            setProfile(client.profile);
                            setProjects(client.projectIds);
                            setConfig(next);
                          })
                        }
                      >
                        安装与配置
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
                    <p>
                      撤销后此应用立即不能调用协作工具；已有任务、附件和改动保留，不占用有效接入名额。
                    </p>
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
                          if (config?.id === client.id || editing?.id === client.id) {
                            setConfig(undefined);
                            setEditing(undefined);
                          }
                          key.current = { payload: '', id: crypto.randomUUID() };
                          await load();
                          setNotice('授权已撤销，历史记录保留，接入名额已释放。');
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
          {!!view?.clients.some((client) => !client.enabled) && (
            <details className={s.history}>
              <summary>
                已撤销记录 {view.clients.filter((client) => !client.enabled).length} ·
                不占用有效名额
              </summary>
              {view.clients
                .filter((client) => !client.enabled)
                .map((client) => (
                  <article className={s.client} key={client.id}>
                    <div className={s.clientHeading}>
                      <strong>{client.name}</strong>
                      <span className={s.badge}>已撤销</span>
                    </div>
                    <p>
                      {client.projectIds
                        .map((id) => view.projects.find((project) => project.id === id)?.name ?? id)
                        .join('、')}
                    </p>
                  </article>
                ))}
            </details>
          )}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
