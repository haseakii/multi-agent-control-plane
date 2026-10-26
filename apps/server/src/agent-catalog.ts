import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentDefinitionSchema } from '@control-plane/core';
import { inspectAgentConfiguration } from '@control-plane/runner';
import type { AgentControlService } from './agent-control.js';
import { discoverAgentEntries, DiscoverEntryInputSchema } from './agent-entry-discovery.js';

export const OFFICIAL_CATALOG_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export const CATALOG_LIMIT = 1_048_576;
export const CATALOG_TIMEOUT = 8_000;
const text = z.string().max(16_384);
const uri = text.url();
const args = z.array(text).max(128).optional();
const env = z.record(z.string().max(256), text).optional();
const target = z
  .object({
    archive: uri,
    cmd: text,
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    args,
    env,
  })
  .strict();
const platforms = z.enum([
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64',
]);
const distribution = z
  .object({
    binary: z
      .partialRecord(platforms, target)
      .refine((value) => Object.keys(value).length > 0)
      .optional(),
    npx: z
      .object({ package: text.min(1), args, env })
      .strict()
      .optional(),
    uvx: z
      .object({ package: text.min(1), args, env })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
// Official agent.schema.json structural contract plus bounded local resource limits.
// The upstream license_url exception is schema compatibility, never a runtime role rule.
export const CatalogEntrySchema = z
  .object({
    id: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: text.min(1),
    version: z
      .string()
      .max(128)
      .regex(/^\d+\.\d+\.\d+$/),
    description: text.min(1),
    repository: uri.optional(),
    website: uri.optional(),
    authors: z.array(text).max(100).optional(),
    license: text.optional(),
    license_url: uri.optional(),
    icon: text.optional(),
    distribution,
    preview: z
      .object({
        version: z
          .string()
          .max(128)
          .regex(/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/),
        distribution,
      })
      .strict()
      .optional(),
  })
  .refine(
    (value) => value.id === 'dimcode' || value.license_url !== undefined,
    'License URL required by official schema',
  );
// The generic registry can also contain non-agent collections (extensions).
// Discard those collections; never map them to runtimes or execute their metadata.
export const CatalogSchema = z
  .object({ version: z.literal('1.0.0'), agents: z.array(CatalogEntrySchema).max(500) })
  .strip()
  .refine(
    (value) => new Set(value.agents.map((agent) => agent.id)).size === value.agents.length,
    'Duplicate agent id',
  );
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
const CacheSchema = z
  .object({
    format: z.literal(1),
    source: z.literal(OFFICIAL_CATALOG_URL),
    fetchedAt: z.string().datetime(),
    registry: CatalogSchema,
  })
  .strict();
type Cache = z.infer<typeof CacheSchema>;

export interface CatalogCache {
  read(): string | undefined;
  write(value: string): void;
}
function rejectLinks(filename: string) {
  const path = resolve(filename),
    root = parse(path).root;
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Catalog cache links rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}
export class FileCatalogCache implements CatalogCache {
  constructor(private readonly filename: string) {}
  read() {
    rejectLinks(this.filename);
    if (!existsSync(this.filename)) return undefined;
    const stat = lstatSync(this.filename);
    if (!stat.isFile() || stat.size > CATALOG_LIMIT * 2) throw new Error('Invalid catalog cache');
    return readFileSync(this.filename, 'utf8');
  }
  write(value: string) {
    rejectLinks(this.filename);
    mkdirSync(dirname(this.filename), { recursive: true });
    rejectLinks(this.filename);
    const temp = this.filename + '.tmp-' + randomUUID();
    try {
      writeFileSync(temp, value, { flag: 'wx' });
      renameSync(temp, this.filename);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}
function platformKey(platform: NodeJS.Platform, arch: string) {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  return `${os}-${cpu}`;
}
export class AgentCatalogService {
  private current: Cache | undefined;
  private error: string | null = null;
  private errorCode: string | null = null;
  private refreshing = false;
  private storage: 'empty' | 'cache' | 'memory' = 'empty';
  constructor(
    private readonly cache?: CatalogCache,
    private readonly request: typeof fetch = fetch,
  ) {
    try {
      const text = cache?.read();
      if (text !== undefined) {
        this.current = CacheSchema.parse(JSON.parse(text));
        this.storage = 'cache';
      }
    } catch {
      this.errorCode = 'CACHE_READ';
      this.error = '本机目录缓存无效或不可读；可手动刷新。未启动任何 Agent。';
    }
  }
  snapshot() {
    return {
      source: OFFICIAL_CATALOG_URL,
      fetchedAt: this.current?.fetchedAt ?? null,
      stale: this.current ? Date.now() - Date.parse(this.current.fetchedAt) > 86_400_000 : false,
      storage: this.storage,
      error: this.error,
      errorCode: this.errorCode,
      platform: platformKey(process.platform, process.arch),
      entries: this.current?.registry.agents ?? [],
      limits: { bytes: CATALOG_LIMIT, timeoutMs: CATALOG_TIMEOUT, redirects: 'reject' },
      installationSupported: false,
    };
  }
  entry(id: string) {
    return this.current?.registry.agents.find((entry) => entry.id === id);
  }
  async refresh() {
    if (this.refreshing) throw new Error('CATALOG_BUSY');
    this.refreshing = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(OFFICIAL_CATALOG_URL, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected ||
        (response.url && response.url !== OFFICIAL_CATALOG_URL)
      )
        throw new Error('CATALOG_REDIRECT');
      if (response.status !== 200) throw new Error('CATALOG_HTTP');
      if (
        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new Error('CATALOG_CONTENT_TYPE');
      const length = Number(response.headers.get('content-length'));
      if (length > CATALOG_LIMIT) throw new Error('CATALOG_SIZE');
      if (!response.body) throw new Error('CATALOG_EMPTY');
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > CATALOG_LIMIT) throw new Error('CATALOG_SIZE');
        chunks.push(item.value);
      }
      const registry = CatalogSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const current = CacheSchema.parse({
        format: 1,
        source: OFFICIAL_CATALOG_URL,
        fetchedAt: new Date().toISOString(),
        registry,
      });
      this.current = current;
      this.storage = 'memory';
      this.error = null;
      this.errorCode = null;
      try {
        if (this.cache) {
          this.cache.write(JSON.stringify(current));
          this.storage = 'cache';
        }
      } catch {
        this.errorCode = 'CACHE_WRITE';
        this.error = '目录已读取，但缓存保存失败；本次仅内存可用。';
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      this.errorCode = controller.signal.aborted
        ? 'TIMEOUT'
        : error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')
          ? 'FORMAT'
          : code.startsWith('CATALOG_')
            ? code.slice(8)
            : 'NETWORK';
      const reason: Record<string, string> = {
        TIMEOUT: '目录请求超时',
        FORMAT: '目录格式校验未通过',
        REDIRECT: '目录重定向被拒绝',
        HTTP: '目录返回非200状态',
        CONTENT_TYPE: '目录响应类型无效',
        SIZE: '目录超过大小限制',
        EMPTY: '目录响应为空',
        NETWORK: '目录网络请求失败',
      };
      this.error =
        '官方目录刷新失败：' +
        (reason[this.errorCode] ?? '目录校验失败') +
        '；保留原缓存。未下载或执行 Agent。';
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      clearTimeout(timer);
      this.refreshing = false;
    }
    return this.snapshot();
  }
}

const BindSchema = z
  .object({ entryId: z.string().max(128), definition: AgentDefinitionSchema })
  .strict();
export function registerAgentCatalogRoutes(
  app: FastifyInstance,
  catalog: AgentCatalogService,
  agents: AgentControlService,
) {
  app.get('/api/agent-catalog', async () => catalog.snapshot());
  app.post('/api/agent-catalog/discover-local', async (request, reply) => {
    const input = DiscoverEntryInputSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: '请选择目录产品；安装目录须为本机完整路径。' });
    const entry = catalog.entry(input.data.entryId);
    if (!entry) return reply.code(404).send({ error: '产品不在当前目录中，请刷新目录后重试。' });
    return discoverAgentEntries(entry, catalog.snapshot().platform, agents.list(), {
      ...(input.data.directory ? { directory: input.data.directory } : {}),
    });
  });
  app.post('/api/agent-catalog/refresh', async (request, reply) => {
    if (request.body !== undefined && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: '刷新不接受自定义来源或命令。' });
    try {
      return await catalog.refresh();
    } catch {
      return reply.code(409).send({ error: '目录正在刷新，请等待当前请求结束。' });
    }
  });
  app.post('/api/agent-catalog/bind-local', async (request, reply) => {
    const parsed = BindSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '本地绑定配置无效。' });
    if (!catalog.entry(parsed.data.entryId))
      return reply.code(404).send({ error: '目录项不存在；可刷新目录或使用自定义入口。' });
    const definition = { ...parsed.data.definition, enabled: false };
    const inspection = inspectAgentConfiguration(definition, { localOnly: true });
    if (!inspection.offlineChecksPassed)
      return reply.code(400).send({
        error: '请明确选择本机已有的绝对可执行路径及参数。未启动 Agent。',
        issues: inspection.issues,
      });
    try {
      return reply.code(201).send(agents.create(definition));
    } catch {
      return reply.code(409).send({ error: '注册失败；请检查 Agent ID 是否重复。' });
    }
  });
}
