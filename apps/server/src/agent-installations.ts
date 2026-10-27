import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AgentIdSchema,
  type AgentInstallation,
  type InstalledAgentPackage,
} from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import { OFFICIAL_CATALOG_URL, type AgentCatalogService } from './agent-catalog.js';
import type { AgentControlService } from './agent-control.js';
import type { NetworkSettingsService } from './network-settings.js';
import {
  AgentPackageInstallError,
  installAgentPackage,
  npmRuntime,
  packagePlan,
} from './agent-package-install.js';
import { TaskControlError } from './task-control.js';
import type { AgentMembersService } from './agent-members.js';
import type { DownloadProgress } from './agent-package-io.js';
import { AgentPackageMaintenance } from './agent-package-maintenance.js';
import { inspectAgentConfiguration } from '@control-plane/runner';
import { discoverAgentEntries } from './agent-entry-discovery.js';

export const StartAgentInstallSchema = z
  .object({
    requestId: z.string().uuid(),
    entryId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
export class AgentInstallationsService {
  readonly maintenance: AgentPackageMaintenance;
  private readonly repo;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  // Byte counters are live telemetry, not durable task state or per-chunk database writes.
  private readonly downloads = new Map<string, DownloadProgress>();
  constructor(
    private readonly options: {
      storage: SqliteStorage;
      catalog: AgentCatalogService;
      agents: AgentControlService;
      network: NetworkSettingsService;
      root: string;
      releaseRoot: string;
      installPackage?: typeof installAgentPackage;
      members?: AgentMembersService;
    },
  ) {
    this.repo = options.storage.repositories.agentInstallations;
    this.maintenance = new AgentPackageMaintenance({ ...options, busy: () => this.busy });
    for (const row of this.repo.list())
      if (row.state === 'removing')
        this.save(row, {
          state: 'removal-failed',
          message: '上次卸载被中断，请重新预览后继续卸载。',
        });
      else if (['queued', 'downloading', 'installing', 'checking'].includes(row.state))
        this.save(row, {
          state: 'failed',
          message: '上次安装被中断，原文件已保留。可以直接重试。',
        });
  }
  list() {
    const origins = this.options.storage.repositories.agentMemberOrigins.list();
    const agents = this.options.agents.list();
    const available = new Set(this.discoverablePackages().map((row) => row.id));
    return this.repo
      .list()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => ({
        ...row,
        progress: this.downloads.get(row.id),
        canCancel:
          this.active.has(row.id) && ['queued', 'downloading', 'installing'].includes(row.state),
        cancelling: this.controllers.get(row.id)?.signal.aborted ?? false,
        installed:
          !['removing', 'removal-failed', 'uninstalled'].includes(row.state) &&
          (available.has(row.id) ||
            (!row.package &&
              !!agents.find(
                (a) => a.definition.id === row.agentId && a.localEntry?.offlineChecksPassed,
              ))),
        members: agents
          .filter(
            (a) =>
              a.definition.id === row.agentId ||
              origins.some((o) => o.installationId === row.id && o.id === a.definition.id),
          )
          .map((a) => ({
            id: a.definition.id,
            name: a.definition.name,
            enabled: a.definition.enabled,
            readiness: a.readiness,
            authMethods: a.authMethods,
            connectionOperation: a.connectionOperation,
          })),
      }));
  }
  get busy() {
    return this.active.size > 0 || !!this.options.members?.busy;
  }
  async settle() {
    await Promise.allSettled(this.active.values());
  }
  plan(entryId: string) {
    const entry = this.options.catalog.entry(entryId);
    if (!entry) throw new TaskControlError(404, '目录产品不存在，请先刷新目录。');
    return {
      ...packagePlan(
        entry,
        this.options.catalog.snapshot().platform,
        !!npmRuntime(this.options.releaseRoot),
      ),
      installationRoot: this.options.root,
      runtimeDirectory: join(dirname(this.options.root), 'runtimes'),
    };
  }
  private save(row: AgentInstallation, patch: Partial<AgentInstallation>) {
    return this.repo.upsert({ ...row, ...patch, updatedAt: new Date().toISOString() });
  }
  private localPackage(row: AgentInstallation): InstalledAgentPackage | undefined {
    if (['removing', 'removal-failed', 'uninstalled'].includes(row.state)) return undefined;
    if (row.package) return row.package;
    const agent = row.agentId
      ? this.options.agents.list().find((a) => a.definition.id === row.agentId)
      : undefined;
    if (!agent) return undefined;
    const pkg: InstalledAgentPackage = {
      runtime: agent.definition.runtime,
      source: {
        entryId: row.entryId,
        entryName: agent.definition.name,
        catalogVersion: row.version,
        catalogUrl: OFFICIAL_CATALOG_URL,
      },
      origin: 'registered-entry',
    };
    this.save(row, { package: pkg });
    return pkg;
  }
  async createMember(id: string, raw: unknown) {
    const row = this.repo.get(id);
    if (!row) throw new TaskControlError(404, '安装记录不存在。');
    if (this.active.has(id))
      throw new TaskControlError(409, '此程序正在安装或恢复，请等待当前操作完成。');
    const pkg = this.localPackage(row);
    if (!pkg) throw new TaskControlError(409, '此程序还未安装完成，请先完成安装。');
    if (!this.options.members) throw new TaskControlError(503, '此服务未启用成员创建。');
    return this.options.members.fromPackage(id, pkg, raw);
  }
  start(raw: unknown) {
    const input = StartAgentInstallSchema.parse(raw),
      previous = this.repo.get(input.requestId);
    if (previous) {
      if (
        previous.entryId !== input.entryId ||
        previous.version !== input.version ||
        previous.planHash !== input.planHash
      )
        throw new TaskControlError(409, '安装请求已使用，请重新确认。');
      return previous;
    }
    const plan = this.plan(input.entryId);
    if (plan.version !== input.version || plan.planHash !== input.planHash)
      throw new TaskControlError(409, '目录安装内容已更新，请重新查看并确认。');
    const existing = this.list().find(
      (row) =>
        row.entryId === input.entryId && row.version === input.version && row.state === 'ready',
    );
    if (existing && this.discoverablePackages().some((row) => row.id === existing.id))
      return existing;
    const discovery = discoverAgentEntries(
      this.options.catalog.entry(input.entryId)!,
      this.options.catalog.snapshot().platform,
      this.options.agents.list(),
      {
        installedPackages: this.discoverablePackages(),
      },
    );
    if (
      discovery.candidates.some(
        (candidate) =>
          candidate.available === true &&
          (candidate.source !== 'registered' || candidate.association === 'linked'),
      )
    )
      throw new TaskControlError(
        409,
        '发现本机已有可用程序，请先使用“查找本机入口”复用，避免重复下载。',
      );
    if (this.busy) throw new TaskControlError(409, '有成员正在安装，请等待完成后再安装。');
    const at = new Date().toISOString();
    const row = this.repo.upsert({
      id: input.requestId,
      entryId: input.entryId,
      version: input.version,
      planHash: input.planHash,
      state: 'queued',
      message: '已排队，正在准备隔离安装…',
      createdAt: at,
      updatedAt: at,
    });
    this.launch(row);
    return row;
  }
  retry(id: string) {
    const row = this.repo.get(id);
    if (!row) throw new TaskControlError(404, '安装记录不存在。');
    if (this.active.has(id)) return row;
    if (this.busy) throw new TaskControlError(409, '有成员正在安装，请稍后重试。');
    if (!['failed', 'cancelled', 'needs-attention'].includes(row.state)) return row;
    const local = this.localPackage(row);
    if (!local) {
      const plan = this.plan(row.entryId);
      if (plan.planHash !== row.planHash)
        throw new TaskControlError(409, '安装来源已改变，请重新选择产品并确认。');
    }
    const next = this.save(row, {
      state: 'queued',
      message: '正在重试；已安装的入口和账号状态保留…',
    });
    this.launch(next);
    return next;
  }

  /** Read only known successful install metadata, including packages without a registered member. */
  discoverablePackages() {
    return this.repo
      .list()
      .filter(
        (row) =>
          row.package &&
          ![
            'queued',
            'downloading',
            'installing',
            'removing',
            'removal-failed',
            'uninstalled',
          ].includes(row.state),
      )
      .filter(
        (row) =>
          inspectAgentConfiguration(
            {
              id: 'local-check',
              name: 'Local package',
              enabled: false,
              runtime: row.package!.runtime,
              capabilities: [],
              auth: { mode: 'agent-managed' },
              orchestration: { canBeBoss: false },
              controlBridge: { transport: 'none', scopes: [] },
            },
            { localOnly: true },
          ).offlineChecksPassed,
      );
  }
  private launch(row: AgentInstallation) {
    const controller = new AbortController();
    this.controllers.set(row.id, controller);
    this.downloads.delete(row.id);
    const promise = this.execute(row, controller.signal).finally(() => {
      this.active.delete(row.id);
      this.controllers.delete(row.id);
      this.downloads.delete(row.id);
    });
    this.active.set(row.id, promise);
  }
  cancel(id: string) {
    const row = this.repo.get(id);
    if (!row) throw new TaskControlError(404, '安装记录不存在。');
    if (!this.active.has(id)) return row;
    if (!['queued', 'downloading', 'installing'].includes(row.state))
      throw new TaskControlError(409, '程序下载与安装已完成，正在检查连接，请等待检查结束。');
    this.controllers.get(id)?.abort();
    return { ...row, cancelling: true };
  }
  private async execute(initial: AgentInstallation, signal: AbortSignal) {
    let row = initial;
    try {
      let pkg = this.localPackage(row);
      // A legacy registration can be recovered without fetching a registry.
      row = this.repo.get(row.id)!;
      let agent = row.agentId
        ? this.options.agents.list().find((a) => a.definition.id === row.agentId)
        : undefined;
      if (!agent) {
        if (!pkg) {
          const plan = this.plan(row.entryId);
          if (plan.planHash !== row.planHash) throw new Error('Catalog changed.');
          // Persist before creating files, so failures and restarts retain their exact location.
          const directory = join(this.options.root, row.entryId, row.version, row.id, randomUUID());
          row = this.save(row, { directory });
          const runtime = await (this.options.installPackage ?? installAgentPackage)({
            plan,
            directory,
            releaseRoot: this.options.releaseRoot,
            runtimeRoot: join(dirname(this.options.root), 'runtimes'),
            nodeExecutable: existsSync(join(dirname(this.options.root), 'runtime/node.exe'))
              ? join(dirname(this.options.root), 'runtime/node.exe')
              : process.execPath,
            network: this.options.network,
            signal,
            phase: (state, message) => {
              signal.throwIfAborted();
              this.downloads.delete(row.id);
              row = this.save(row, { state, message });
            },
            progress: (progress) => {
              if (!signal.aborted) this.downloads.set(row.id, progress);
            },
          });
          signal.throwIfAborted();
          pkg = {
            runtime,
            origin: 'installation',
            source: {
              entryId: plan.entryId,
              entryName: plan.name,
              catalogVersion: plan.version,
              catalogUrl: OFFICIAL_CATALOG_URL,
            },
          };
          row = this.save(row, { package: pkg });
        }
        const agentId = AgentIdSchema.parse('installed-' + row.id);
        // Journal the intended identity first so a crash after registration can resume it.
        row = this.save(row, {
          state: 'checking',
          agentId,
          message: '程序已安装，正在检查 ACP 连接；不会发送模型提示…',
        });
        agent = this.options.agents.create(
          {
            id: agentId,
            name: pkg.source.entryName,
            enabled: true,
            runtime: pkg.runtime,
            capabilities: [],
            auth: { mode: 'agent-managed' },
            orchestration: { canBeBoss: false },
            controlBridge: {
              transport: 'mcp',
              scopes: ['agent.messaging', 'artifact.read', 'artifact.publish', 'task.status'],
            },
          },
          pkg.source,
        );
      } else if (!agent.definition.enabled)
        this.options.agents.update(agent.definition.id, { enabled: true });
      row = this.save(row, {
        state: 'checking',
        message: '正在检查 ACP 连接；账号登录由成员自己处理…',
      });
      const observed = await this.options.agents.probe(agent.definition.id);
      if (observed.readiness.runtime !== 'ready') {
        this.options.agents.update(agent.definition.id, { enabled: false });
        this.save(row, {
          state: 'needs-attention',
          message:
            '程序已安装，但 ACP 连接未就绪。' +
            (observed.error ?? '请检查程序入口。') +
            '可重试连接，不会重新下载。',
        });
        return;
      }
      this.save(row, {
        state: 'ready',
        message: '安装与 ACP 连接检查完成。请在下方登录后使用；账号授权由成员自己管理。',
      });
    } catch (error) {
      if (signal.aborted) {
        this.save(row, {
          state: 'cancelled',
          message:
            '已取消。本次下载和安装已停止，未完成文件保留，可点击重新安装。原有成员不受影响。',
        });
        return;
      }
      const stage = {
        queued: '准备',
        downloading: '下载',
        installing: '安装',
        checking: '连接检查',
        ready: '安装',
        failed: '安装',
        cancelled: '安装',
        'needs-attention': '连接检查',
        removing: '卸载',
        'removal-failed': '卸载',
        uninstalled: '安装',
      }[row.state];
      this.save(row, {
        state: 'failed',
        message:
          error instanceof AgentPackageInstallError
            ? error.message
            : `${stage}未完成。请检查网络代理、磁盘空间或产品兼容性，再重试；安装文件和原有成员保留。`,
      });
    }
  }
}
export function registerAgentInstallationRoutes(
  app: FastifyInstance,
  service: AgentInstallationsService,
) {
  const handler = (action: () => unknown, reply: import('fastify').FastifyReply) =>
    Promise.resolve()
      .then(action)
      .catch((error) =>
        reply
          .code(
            error instanceof TaskControlError
              ? error.statusCode
              : error instanceof z.ZodError
                ? 400
                : 500,
          )
          .send({
            error:
              error instanceof TaskControlError
                ? error.message
                : '安装请求未完成，请核对产品后重试。',
          }),
      );
  app.get('/api/agent-installations', async () => ({
    installations: service.list(),
    busy: service.busy,
  }));
  app.get('/api/agent-catalog/:id/install-plan', (request, reply) =>
    handler(
      () => service.plan(z.object({ id: z.string().min(1).max(128) }).parse(request.params).id),
      reply,
    ),
  );
  app.post('/api/agent-installations', (request, reply) =>
    handler(() => service.start(request.body), reply),
  );
  app.post('/api/agent-installations/:id/retry', (request, reply) =>
    handler(() => {
      z.object({}).strict().parse(request.body);
      return service.retry(z.object({ id: z.string().uuid() }).parse(request.params).id);
    }, reply),
  );
  app.post('/api/agent-installations/:id/members', (request, reply) =>
    handler(
      () =>
        service.createMember(
          z.object({ id: z.string().uuid() }).strict().parse(request.params).id,
          request.body,
        ),
      reply,
    ),
  );
  app.post('/api/agent-installations/:id/cancel', (request, reply) =>
    handler(() => {
      z.object({}).strict().parse(request.body);
      return service.cancel(z.object({ id: z.string().uuid() }).strict().parse(request.params).id);
    }, reply),
  );
  app.post('/api/agent-installations/:id/maintenance-preview', (request, reply) =>
    handler(
      () =>
        service.maintenance.preview(
          z.object({ id: z.string().uuid() }).strict().parse(request.params).id,
          request.body,
        ),
      reply,
    ),
  );
  app.post('/api/agent-installations/:id/maintenance', (request, reply) =>
    handler(
      () =>
        service.maintenance.apply(
          z.object({ id: z.string().uuid() }).strict().parse(request.params).id,
          request.body,
        ),
      reply,
    ),
  );
  app.addHook('preClose', async () => {
    await service.settle();
  });
}
