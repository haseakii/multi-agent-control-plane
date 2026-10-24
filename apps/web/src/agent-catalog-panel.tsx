import { useEffect, useRef, useState } from 'react';

export type CatalogChoice = { id: string; name: string; version: string };
type Entry = CatalogChoice & {
  description: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  website?: string;
  distribution: {
    binary?: Record<string, { cmd: string; sha256?: string }>;
    npx?: { package: string };
    uvx?: { package: string };
  };
  preview?: unknown;
};
type Catalog = {
  source: string;
  fetchedAt: string | null;
  stale: boolean;
  storage: string;
  error: string | null;
  platform: string;
  entries: Entry[];
};
async function readCatalog(refresh = false): Promise<Catalog> {
  const res = await fetch(
    '/api/agent-catalog' + (refresh ? '/refresh' : ''),
    refresh ? { method: 'POST' } : undefined,
  );
  if (!res.ok) throw Error(`目录读取失败（HTTP ${res.status}）`);
  return res.json() as Promise<Catalog>;
}
export function safeCatalogLink(value: string | undefined): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function AgentCatalogPanel({ onPrepare }: { onPrepare: (choice: CatalogChoice) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [error, setError] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    let live = true;
    void readCatalog()
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch((e) => {
        if (live) setError(String(e.message));
      });
    return () => {
      live = false;
    };
  }, []);
  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setCatalog(await readCatalog(true));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '目录读取失败');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const entries = (catalog?.entries ?? []).filter((e) =>
    `${e.name} ${e.id} ${(e.authors ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="panel span-2 catalog-panel" aria-label="ACP 接入目录">
      <div className="panel-heading">
        <div>
          <p className="kicker">ACP 接入中心 · A0</p>
          <h2>官方目录与本地入口</h2>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          {busy ? '正在刷新目录…' : '刷新官方目录'}
        </button>
      </div>
      <p className="section-note">
        目录不是已安装清单。刷新仅下载目录元数据；不会下载软件、登录、探针或调用模型。自定义入口继续可用。
      </p>
      <p className="catalog-status">
        {catalog?.fetchedAt
          ? `目录检查时间：${catalog.fetchedAt} · ${catalog.storage === 'memory' ? '仅内存，重启不保留' : catalog.stale ? '缓存已过期，可手动刷新' : '本机缓存可用'}`
          : '尚无目录缓存，请手动刷新。'}
        {catalog ? ` · 当前平台 ${catalog.platform}` : ''}
      </p>
      {error || catalog?.error ? (
        <p role="alert" className="inline-error">
          {error ?? catalog?.error}
        </p>
      ) : null}
      <label className="catalog-search">
        搜索目录
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="按名称、ID 或发布者搜索"
        />
      </label>
      <div className="catalog-grid">
        {entries.slice(0, 50).map((entry) => {
          const binary = catalog ? entry.distribution.binary?.[catalog.platform] : undefined;
          const terms = safeCatalogLink(entry.license_url);
          return (
            <article className="catalog-card" key={entry.id}>
              <div>
                <h3>{entry.name}</h3>
                <small>
                  {entry.id} · 目录版本 {entry.version}
                </small>
              </div>
              <p>{entry.description}</p>
              <p className="catalog-status">
                发布者：{entry.authors?.join('、') || '目录未报告'} · 许可：
                {entry.license || '目录未报告'}
              </p>
              <p className="catalog-status">
                {binary
                  ? '目录含当前平台二进制'
                  : entry.distribution.npx || entry.distribution.uvx
                    ? '包分发；本机兼容性未验证'
                    : '目录无当前平台二进制，可使用自定义入口'}{' '}
                · 本机安装/版本未核实
              </p>
              <p className="catalog-status">
                {binary?.sha256
                  ? '目录提供上游校验和（尚未下载校验）'
                  : '未提供当前平台上游校验和；本地哈希不等于发布者验签'}
              </p>
              {entry.preview ? <p>另有 preview 元数据；本批不选择或启用 preview。</p> : null}
              <div className="card-actions">
                <button
                  type="button"
                  onClick={() =>
                    onPrepare({ id: entry.id, name: entry.name, version: entry.version })
                  }
                >
                  绑定已有本地入口
                </button>
                {terms ? (
                  <a href={terms} target="_blank" rel="noopener noreferrer">
                    许可与条款
                  </a>
                ) : (
                  <span>许可链接不可安全打开</span>
                )}
              </div>
              <details className="technical-details">
                <summary>目录分发详情（只读）</summary>
                <pre>{JSON.stringify(entry.distribution, null, 2)}</pre>
                <small>命令、参数、环境值和 URL 均为不可信目录数据，不会导入或执行。</small>
              </details>
            </article>
          );
        })}
      </div>
      {catalog && entries.length === 0 ? (
        <p className="empty">没有匹配目录项。仍可在下方注册自定义入口。</p>
      ) : null}
      {entries.length > 50 ? <p>仅显示前 50 项，请使用搜索缩小范围。</p> : null}
      <div className="card-actions catalog-unavailable">
        <button type="button" disabled>
          安装 / 更新（A0 未实现）
        </button>
        <button type="button" disabled>
          目录登录（A0 不提供）
        </button>
      </div>
    </section>
  );
}
