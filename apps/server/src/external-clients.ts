import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { SqliteStorage } from '@control-plane/storage';
import {
  ExternalClientRecordSchema,
  ExternalClientTargetSchema,
  ExternalClientAccessSchema,
  AuditEventSchema,
  type ExternalClientRecord,
} from '@control-plane/core';
import { ClientAccessFileSchema, clientToolDefinitions } from '@control-plane/fleet-mcp';
import type { ControlPlaneRuntime } from './runtime-composition.js';
import { TaskControlError } from './task-control.js';
import { installCodexClient, codexCliPath } from './external-client-install.js';

const ProjectsSchema = ExternalClientAccessSchema.shape.projects.refine(
  (values) => new Set(values.map((value) => value.projectId)).size === values.length,
  'Duplicate project grant',
);
export const CreateExternalClientSchema = z
  .object({
    requestId: z.string().uuid(),
    name: z.string().trim().min(1).max(128),
    target: ExternalClientTargetSchema,
    profile: z.enum(['read', 'collaborate']),
    projectId: z.string().min(1).max(128).optional(),
    workspaceConfirmation: z
      .object({ workspaceId: z.string(), rootPath: z.string(), version: z.string() })
      .strict()
      .optional(),
    projects: ProjectsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.projects
        ? value.projectId === undefined && value.workspaceConfirmation === undefined
        : !!value.projectId,
    'Choose projects or the legacy project field',
  );
export const UpdateExternalClientGrantsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    requestId: z.string().uuid(),
    projects: ProjectsSchema,
    profile: z.enum(['read', 'collaborate']),
  })
  .strict();
type CreateInput = z.infer<typeof CreateExternalClientSchema>;
export class ExternalClientsService {
  private readonly repo;
  constructor(
    private readonly options: {
      storage: SqliteStorage;
      runtime: ControlPlaneRuntime;
      installationFile?: string;
      localHost?: { root: string; runtime: string; entry: string };
      baseUrl: string;
      readLegacy: () => unknown;
      installCodex?: typeof installCodexClient;
    },
  ) {
    this.repo = options.storage.repositories;
  }
  private allAccess = () => {
    const legacy = ClientAccessFileSchema.parse(this.options.readLegacy()).clients;
    const records = this.repo.externalClients.list();
    return {
      version: 1,
      clients: [
        ...legacy.filter((client) => !records.some((row) => row.id === client.id)),
        ...records.map((row) => row.access),
      ],
    };
  };
  readAccess = () => ({
    version: 1,
    clients: this.allAccess().clients.filter((client) => client.enabled),
  });
  private validateProjects(projects: z.infer<typeof ProjectsSchema>) {
    const available = this.projects();
    for (const grant of projects) {
      if (!available.some((project) => project.id === grant.projectId))
        throw new TaskControlError(409, '所选项目目录不可用，请重新核对项目授权。');
      this.options.runtime.resolveClientWorkspaceConfirmation(
        grant.projectId,
        grant.workspaceConfirmation,
      );
    }
  }
  private audit(
    access: z.infer<typeof ExternalClientAccessSchema>,
    operation: string,
    revision: number,
    previousProjects?: string[],
  ) {
    for (const projectId of new Set([
      ...(previousProjects ?? []),
      ...access.projects.map((project) => project.projectId),
    ])) {
      if (!this.repo.projects.get(projectId)) continue;
      this.repo.events.append(
        AuditEventSchema.parse({
          id: 'event-' + randomUUID(),
          projectId,
          type: 'client.access.' + operation,
          actor: { type: 'user', id: 'local-owner' },
          payload: {
            clientId: access.id,
            projectIds: access.projects.map((p) => p.projectId),
            ...(previousProjects ? { previousProjectIds: previousProjects } : {}),
            tools: access.tools,
            revision,
            enforcementMode: 'enforced',
            boundary: 'client-gateway',
          },
          occurredAt: new Date().toISOString(),
        }),
      );
    }
  }
  private installation() {
    const file = this.options.installationFile;
    if (!file) {
      if (!this.options.localHost) throw new TaskControlError(503, '本机 MCP 启动入口未配置。');
      return { ...this.options.localHost, file: undefined };
    }
    const state = z
      .object({
        version: z.literal(1),
        runtimeFile: z.string(),
        current: z.object({ releaseDir: z.string() }),
      })
      .parse(JSON.parse(readFileSync(file, 'utf8')));
    return {
      file,
      root: dirname(file),
      runtime: state.runtimeFile,
      entry: join(dirname(file), 'launcher/control-plane.mjs'),
    };
  }
  private connectionFile(id: string) {
    // Managed IDs are generated here. Legacy IDs never become file paths.
    if (!/^client-[a-f0-9-]{36}$/.test(id))
      throw new TaskControlError(409, '旧接入请保留原配置；可撤销后重新生成独立接入。');
    return join(this.installation().root, 'connections', id + '.json');
  }
  projects() {
    return this.repo.projects.list().flatMap((project) => {
      const config = this.repo.projectWorkspaceConfigs.get(project.id);
      if (!config || !['git-worktree', 'task-local'].includes(config.mode)) return [];
      const workspace = this.repo.workspaces.get(config.sourceWorkspaceId);
      if (!workspace) return [];
      let workspaceConfirmation;
      try {
        this.options.runtime.directoryBindings.validateIdentity(workspace);
        if (this.repo.workspaceDirectoryBindings.get(workspace.id))
          workspaceConfirmation = {
            workspaceId: workspace.id,
            rootPath: workspace.rootPath,
            version: this.options.runtime.directoryBindings.persistentConfirmationVersion(
              workspace.id,
            ),
          };
      } catch {
        return [];
      }
      return [
        { id: project.id, name: project.name, rootPath: workspace.rootPath, workspaceConfirmation },
      ];
    });
  }
  projectView() {
    const projects = this.projects();
    const available = new Set(projects.map((project) => project.id));
    return {
      projects,
      unavailableProjects: this.repo.projects
        .list()
        .filter((project) => !available.has(project.id))
        .map((project) => ({ id: project.id, name: project.name })),
    };
  }
  list() {
    const records = this.repo.externalClients.list();
    return this.allAccess().clients.map((access) => {
      const row = records.find((value) => value.id === access.id);
      const uses = access.projects
        .flatMap((p) =>
          this.repo.events.listByProject(p.projectId, {
            taskIds: [],
            types: ['client.tool.called'],
          }),
        )
        .filter(
          (event) =>
            event.actor.id === 'mcp-client:' + access.id && event.payload.outcome === 'allowed',
        );
      return {
        id: access.id,
        name: access.name,
        enabled: access.enabled,
        projectIds: access.projects.map((p) => p.projectId),
        tools: access.tools,
        target: row?.target ?? 'generic',
        profile:
          row?.profile ??
          (access.tools.some((name) =>
            clientToolDefinitions.some((tool) => tool.name === name && !tool.readOnly),
          )
            ? 'collaborate'
            : 'read'),
        createdAt: row?.createdAt,
        configuredAt: row?.configuredAt,
        revision: row?.revision ?? 0,
        lastUsedAt: uses.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]?.occurredAt,
        managed: !!row && /^client-[a-f0-9-]{36}$/.test(row.id),
        connectionAvailable:
          !!row && /^client-[a-f0-9-]{36}$/.test(row.id) && existsSync(this.connectionFile(row.id)),
      };
    });
  }
  create(raw: unknown) {
    const input = CreateExternalClientSchema.parse(raw);
    const projects = [
      ...(input.projects ?? [
        {
          projectId: input.projectId!,
          ...(input.workspaceConfirmation
            ? { workspaceConfirmation: input.workspaceConfirmation }
            : {}),
        },
      ]),
    ].sort((a, b) => a.projectId.localeCompare(b.projectId));
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          name: input.name,
          target: input.target,
          profile: input.profile,
          projects,
        }),
      )
      .digest('hex');
    const existing = this.repo.externalClients
      .list()
      .find((row) => row.requestId === input.requestId);
    if (existing) {
      if (
        existing.requestHash !== requestHash &&
        existing.requestHash !== createHash('sha256').update(JSON.stringify(input)).digest('hex')
      )
        throw new TaskControlError(409, '请求内容已改变，请重新确认接入。');
      return this.configuration(existing.id);
    }
    if (this.readAccess().clients.length >= 64)
      throw new TaskControlError(409, '接入数量已达上限。请先整理旧接入。');
    this.validateProjects(projects);
    const id = 'client-' + randomUUID(),
      token = randomBytes(32).toString('hex');
    const installed = this.installation(),
      file = this.connectionFile(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        baseUrl: this.options.baseUrl,
        token,
        ...(installed.file
          ? {
              start: {
                command: installed.runtime,
                args: [installed.entry, 'serve', '--installation', installed.file],
                cwd: installed.root,
                logFile: join(installed.root, 'logs', id + '.log'),
              },
            }
          : {}),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    this.repo.transaction(() => {
      this.repo.externalClients.upsert(
        ExternalClientRecordSchema.parse({
          id,
          requestId: input.requestId,
          requestHash,
          target: input.target,
          profile: input.profile,
          createdAt: new Date().toISOString(),
          access: {
            id,
            name: input.name,
            enabled: true,
            tokenSha256: createHash('sha256').update(token).digest('hex'),
            projects,
            tools: clientToolDefinitions
              .filter((t) => input.profile === 'collaborate' || t.readOnly)
              .map((t) => t.name),
          },
        }),
      );
      this.audit(this.repo.externalClients.get(id)!.access, 'created', 1);
    });
    return this.configuration(id);
  }
  updateGrants(id: string, raw: unknown) {
    const input = UpdateExternalClientGrantsSchema.parse(raw);
    const projects = [...input.projects].sort((a, b) => a.projectId.localeCompare(b.projectId));
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ projects, profile: input.profile }))
      .digest('hex');
    return this.repo.transaction(() => {
      const row = this.repo.externalClients.get(id),
        access = this.allAccess().clients.find((client) => client.id === id);
      if (!access?.enabled) throw new TaskControlError(409, '接入不存在或已撤销，请重新创建授权。');
      if (row?.lastUpdate?.requestId === input.requestId) {
        if (row.lastUpdate.requestHash !== requestHash)
          throw new TaskControlError(409, '请求内容已改变，请重新确认项目授权。');
        return { id, revision: row.revision };
      }
      if ((row?.revision ?? 0) !== input.expectedRevision)
        throw new TaskControlError(409, '项目授权已在其他位置更新，请刷新后再保存。');
      this.validateProjects(projects);
      const record: ExternalClientRecord = row ?? {
        id,
        access,
        target: 'generic',
        profile: 'collaborate',
        requestId: randomUUID(),
        requestHash: '0'.repeat(64),
        createdAt: new Date().toISOString(),
        revision: 0,
      };
      const next = {
        ...record,
        access: {
          ...access,
          projects,
          tools: clientToolDefinitions
            .filter((tool) => input.profile === 'collaborate' || tool.readOnly)
            .map((tool) => tool.name),
        },
        profile: input.profile,
        revision: record.revision + 1,
        lastUpdate: { requestId: input.requestId, requestHash },
      };
      this.repo.externalClients.upsert(next);
      // Audit both removed and retained project scopes without granting removed scopes.
      this.audit(
        next.access,
        'updated',
        next.revision,
        access.projects.map((project) => project.projectId),
      );
      return { id, revision: next.revision };
    });
  }
  revoke(id: string) {
    const row = this.repo.externalClients.get(id);
    const access = this.allAccess().clients.find((client) => client.id === id);
    if (!access) throw new TaskControlError(404, '接入不存在。');
    if (!access.enabled) return { id, enabled: false };
    const now = new Date().toISOString();
    this.repo.transaction(() => {
      this.repo.externalClients.upsert(
        row
          ? {
              ...row,
              revision: row.revision + 1,
              revokedAt: now,
              access: { ...row.access, enabled: false },
            }
          : {
              id,
              access: { ...access, enabled: false },
              target: 'generic',
              profile: 'collaborate',
              createdAt: now,
              revokedAt: now,
              requestId: randomUUID(),
              requestHash: '0'.repeat(64),
            },
      );
      this.audit(access, 'revoked', (row?.revision ?? 0) + 1);
    });
    return { id, enabled: false };
  }
  configuration(id: string) {
    const row = this.repo.externalClients.get(id);
    if (!row?.access.enabled) throw new TaskControlError(409, '接入已撤销，请重新创建授权。');
    const connection = this.connectionFile(id);
    if (!existsSync(connection))
      throw new TaskControlError(409, '本机连接文件缺失，请撤销此接入并重新生成。');
    const installed = this.installation(),
      name = 'collaboration_' + id.slice(7, 15);
    const server = {
      command: installed.runtime,
      args: installed.file
        ? [installed.entry, 'mcp', '--installation', installed.file, '--connection', connection]
        : [installed.entry, '--connection', connection],
    };
    const config =
      row.target === 'vscode'
        ? { servers: { [name]: { type: 'stdio', ...server } } }
        : { mcpServers: { [name]: server } };
    const installUrl =
      row.target === 'cursor'
        ? 'cursor://anysphere.cursor-deeplink/mcp/install?name=' +
          encodeURIComponent(name) +
          '&config=' +
          encodeURIComponent(Buffer.from(JSON.stringify(server)).toString('base64'))
        : row.target === 'vscode'
          ? 'vscode:mcp/install?' + encodeURIComponent(JSON.stringify({ name, ...server }))
          : undefined;
    return {
      id,
      name,
      target: row.target,
      config:
        row.target === 'codex'
          ? `[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`
          : JSON.stringify(config, null, 2),
      installUrl,
      codexInstallAvailable: row.target === 'codex' && !!codexCliPath(),
      // CLI adapter receives this structure, never arbitrary browser-supplied paths.
      server,
    };
  }
  async install(id: string) {
    const row = this.repo.externalClients.get(id);
    if (!row || row.target !== 'codex')
      throw new TaskControlError(400, '该客户端请使用安装链接或复制完整配置。');
    const configuration = this.configuration(id);
    await (this.options.installCodex ?? installCodexClient)(
      configuration.name,
      configuration.server,
    );
    // Do not revive a grant revoked while the native client was configuring.
    const current = this.repo.externalClients.get(id)!;
    this.repo.externalClients.upsert({ ...current, configuredAt: new Date().toISOString() });
    return {
      id,
      configured: true,
      connected: false,
      message: '已加入 Codex。请在客户端重连此 MCP；首次调用后显示已连接。',
    };
  }
}

export function registerExternalClientRoutes(
  app: FastifyInstance,
  service: ExternalClientsService,
) {
  const guarded =
    (action: () => unknown) => async (_request: unknown, reply: import('fastify').FastifyReply) => {
      try {
        return await action();
      } catch (error) {
        return reply
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
                : error instanceof z.ZodError
                  ? '接入信息无效，请重新选择。'
                  : '操作未完成，已有接入和任务保留。请刷新后重试。',
          });
      }
    };
  app.get(
    '/api/external-clients',
    guarded(() => ({ ...service.projectView(), clients: service.list(), localOnly: true })),
  );
  app.post('/api/external-clients', (request, reply) =>
    guarded(() => service.create(request.body))(request, reply),
  );
  app.patch('/api/external-clients/:id/grants', (request, reply) =>
    guarded(() =>
      service.updateGrants(
        z
          .object({ id: z.string().min(1).max(128) })
          .strict()
          .parse(request.params).id,
        request.body,
      ),
    )(request, reply),
  );
  const id = z.object({ id: z.string().min(1).max(128) }).strict();
  app.get('/api/external-clients/:id/config', (request, reply) =>
    guarded(() => service.configuration(id.parse(request.params).id))(request, reply),
  );
  app.post('/api/external-clients/:id/revoke', (request, reply) =>
    guarded(() => {
      z.object({}).strict().parse(request.body);
      return service.revoke(id.parse(request.params).id);
    })(request, reply),
  );
  app.post('/api/external-clients/:id/install', (request, reply) =>
    guarded(() => {
      z.object({}).strict().parse(request.body);
      return service.install(id.parse(request.params).id);
    })(request, reply),
  );
}
