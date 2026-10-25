import { createHash } from 'node:crypto';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  AgentIdSchema,
  GlobalNetworkChoiceSchema,
  EffectiveNetworkSchema,
  NetworkSettingsSchema,
  SaveNetworkSettingsSchema,
  type AgentDefinition,
  type EffectiveNetwork,
  type NetworkSettings,
  type NetworkSettingsInput,
} from '@control-plane/core';
import {
  NetworkSettingsConflictError,
  type NetworkSettingsRepository,
} from '@control-plane/storage';

const protectedBypass = ['localhost', '127.0.0.1', '::1', '[::1]'];
const proxyKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const supportsManagedHttp = () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major === 22 ? minor! >= 21 : major === 24 ? minor! >= 5 : major! > 24;
};
export class NetworkSettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function resolveNetwork(
  settings: NetworkSettings | NetworkSettingsInput,
  agentId?: string,
  revision = 0,
): EffectiveNetwork {
  const member = agentId ? settings.members[AgentIdSchema.parse(agentId)] : undefined;
  const overridden = member && member.mode !== 'inherit';
  const choice = overridden ? member : settings.global;
  const mode = choice.mode === 'inherit' ? 'unmanaged' : choice.mode;
  const source = overridden ? 'member' : mode === 'unmanaged' ? 'existing' : 'global';
  const bypass = [...new Set([...protectedBypass, ...choice.bypass])];
  const selected = { mode, ...(mode === 'proxy' ? { proxyUrl: choice.proxyUrl } : {}), bypass };
  return EffectiveNetworkSchema.parse({
    ...(agentId ? { agentId } : {}),
    source,
    ...selected,
    revision,
    fingerprint: hash({ source, ...selected }),
    enforcementMode: mode === 'unmanaged' ? 'unavailable' : agentId ? 'cooperative' : 'enforced',
    boundary: agentId ? 'agent-environment' : 'control-plane-http',
  });
}
export function applyNetworkEnvironment(base: Record<string, string>, effective: EffectiveNetwork) {
  if (effective.mode === 'unmanaged') return { ...base };
  const env = { ...base };
  for (const key of proxyKeys) env[key] = effective.mode === 'proxy' ? effective.proxyUrl! : '';
  env.NO_PROXY = env.no_proxy = effective.bypass.join(',');
  env.NODE_USE_ENV_PROXY = effective.mode === 'proxy' ? '1' : '0';
  return env;
}
/** Owned HTTP transport. A proxy failure never falls back to a direct request. */
export async function fetchUsingNetwork(
  url: string | URL,
  init: RequestInit,
  effective: EffectiveNetwork,
  onConnection?: (value: { peerAddress: string; peerPort: number }) => void,
): Promise<Response> {
  const target = new URL(url);
  if (effective.mode === 'unmanaged') return fetch(target, init);
  if (!['http:', 'https:'].includes(target.protocol))
    throw new NetworkSettingsError(400, '仅支持 HTTP/HTTPS 目标。');
  if (!supportsManagedHttp())
    throw new NetworkSettingsError(409, '当前运行时无法可靠应用代理，请使用已验证的日用运行时。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  const proxyEnv =
    effective.mode === 'proxy' && !local
      ? {
          HTTP_PROXY: effective.proxyUrl!,
          HTTPS_PROXY: effective.proxyUrl!,
          NO_PROXY: effective.bypass.join(','),
        }
      : {};
  const options = { proxyEnv } as import('node:http').AgentOptions & {
    proxyEnv: Record<string, string>;
  };
  const agent = target.protocol === 'https:' ? new HttpsAgent(options) : new HttpAgent(options);
  const headers = Object.fromEntries(new Headers(init.headers));
  return new Promise<Response>((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      { method: init.method ?? 'GET', headers, agent, signal: init.signal ?? undefined },
      (response) => {
        if (response.socket.remoteAddress && response.socket.remotePort)
          onConnection?.({
            peerAddress: response.socket.remoteAddress,
            peerPort: response.socket.remotePort,
          });
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            resultHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        response.on('end', () => agent.destroy());
        response.on('close', () => agent.destroy());
        try {
          resolve(
            new Response(
              init.method === 'HEAD' || [204, 205, 304].includes(response.statusCode ?? 0)
                ? null
                : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              {
                status: response.statusCode ?? 502,
                headers: resultHeaders,
              },
            ),
          );
        } catch (error) {
          response.destroy();
          agent.destroy();
          reject(error);
        }
      },
    );
    request.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    if (init.body !== undefined && init.body !== null) {
      request.destroy();
      reject(new NetworkSettingsError(400, '此联网接口不接受请求正文。'));
      return;
    }
    request.end();
  });
}
const NetworkViewSchema = NetworkSettingsSchema.extend({
  effective: z.array(EffectiveNetworkSchema).max(512),
  capabilities: z
    .object({
      proxySchemes: z.array(z.enum(['http', 'https'])),
      authentication: z.literal(false),
      managedHttp: z.boolean(),
      agentBoundary: z.literal('cooperative'),
    })
    .strict(),
}).strict();
export const NetworkTestInputSchema = z
  .object({ choice: GlobalNetworkChoiceSchema, agentId: AgentIdSchema.optional() })
  .strict();
const TestResultSchema = z
  .object({
    result: z.enum(['passed', 'failed']),
    stage: z.enum(['target-http', 'network', 'tls']),
    message: z.string().max(500),
    httpStatus: z.number().int().min(100).max(599).optional(),
    effective: EffectiveNetworkSchema,
    observedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    connection: z
      .object({ peerAddress: z.string().max(128), peerPort: z.number().int().min(1).max(65535) })
      .strict()
      .optional(),
    routeStatus: z.enum(['proxy-observed', 'direct', 'unconfirmed']),
  })
  .strict();
export class NetworkSettingsService {
  constructor(
    readonly repository: NetworkSettingsRepository,
    private readonly agents: () => AgentDefinition[],
  ) {}
  effective(agentId?: string) {
    if (agentId && !this.agents().some((a) => a.id === agentId))
      throw new NetworkSettingsError(404, '找不到此成员。');
    const saved = this.repository.read();
    return resolveNetwork(saved, agentId, saved.revision);
  }
  environment(agent: AgentDefinition) {
    return this.environmentWith(agent, this.effective(agent.id));
  }
  diagnostic(attemptId?: string, agentId?: string) {
    let current = null as ReturnType<NetworkSettingsRepository['getAttempt']> | null;
    let next = null as EffectiveNetwork | null;
    let error: string | undefined;
    try {
      current = attemptId ? (this.repository.getAttempt(attemptId) ?? null) : null;
    } catch {
      error = '本轮网络记录暂不可读；执行和审批记录仍保留。';
    }
    try {
      if (agentId && this.agents().some((agent) => agent.id === agentId))
        next = this.effective(agentId);
    } catch {
      error = '当前网络设置暂不可读；未修改已有执行或登录记录。';
    }
    return {
      current,
      next,
      changedForNext: !!current && !!next && current.effective.fingerprint !== next.fingerprint,
      ...(error ? { error } : {}),
    };
  }
  private environmentWith(agent: AgentDefinition, effective: EffectiveNetwork) {
    const base = Object.fromEntries(
      (agent.runtime.environmentAllowlist ?? []).flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    );
    return applyNetworkEnvironment(base, effective);
  }
  view() {
    const saved = this.repository.read();
    return NetworkViewSchema.parse({
      ...saved,
      effective: this.agents().map((a) => resolveNetwork(saved, a.id, saved.revision)),
      capabilities: {
        proxySchemes: ['http', 'https'],
        authentication: false,
        managedHttp: supportsManagedHttp(),
        agentBoundary: 'cooperative',
      },
    });
  }
  save(raw: unknown) {
    const { expectedRevision, ...input } = SaveNetworkSettingsSchema.parse(raw);
    const agents = new Set<string>(this.agents().map((a) => a.id));
    if (Object.keys(input.members).some((id) => !agents.has(id)))
      throw new NetworkSettingsError(409, '成员列表已变化，请读取最新设置后核对；未部分保存。');
    const current = this.repository.read();
    const signature = (value: { global: unknown; members: Record<string, unknown> }) =>
      hash({
        global: value.global,
        members: Object.fromEntries(
          Object.entries(value.members).sort(([a], [b]) => a.localeCompare(b)),
        ),
      });
    if (signature(current) === signature(input)) return this.view();
    try {
      this.repository.save(expectedRevision, input);
      return this.view();
    } catch (error) {
      if (error instanceof NetworkSettingsConflictError)
        throw new NetworkSettingsError(
          409,
          '设置已在其它窗口变化，请读取最新版本；本地草稿仍保留。',
        );
      throw error;
    }
  }
  fetch: typeof fetch = async (input, init = {}) =>
    fetchUsingNetwork(
      typeof input === 'string' || input instanceof URL ? input : input.url,
      init,
      this.effective(),
    );
  async test(raw: unknown) {
    const input = NetworkTestInputSchema.parse(raw);
    if (input.agentId && !this.agents().some((a) => a.id === input.agentId))
      throw new NetworkSettingsError(404, '找不到此成员。');
    const saved = this.repository.read();
    // Tests always exercise the unsaved route through an owned transport; never claim native agent traffic.
    const effective = resolveNetwork(
      { global: input.choice, members: {} },
      undefined,
      saved.revision,
    );
    const begin = Date.now();
    let connection: { peerAddress: string; peerPort: number } | undefined;
    let result: Record<string, unknown>;
    try {
      const response = await fetchUsingNetwork(
        'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
        {
          signal: AbortSignal.timeout(10000),
          redirect: 'manual',
          headers: { accept: 'application/json' },
        },
        effective,
        (value) => {
          connection = value;
        },
      );
      await response.body?.cancel();
      result = {
        result: response.ok ? 'passed' : 'failed',
        stage: 'target-http',
        httpStatus: response.status,
        message: response.ok
          ? '官方目录服务连接成功；未登录或发送模型提示。此结果不代表成员全部流量已验证。'
          : `目标服务返回 HTTP ${response.status}；未改动成员登录状态。`,
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const tls = /CERT|TLS|SSL/.test(code);
      result = {
        result: 'failed',
        stage: tls ? 'tls' : 'network',
        message: tls
          ? 'TLS 证书校验未通过；请检查代理证书配置，未关闭校验。'
          : '网络检查未成功。请核对代理地址、代理程序与目标网络；未将超时判为登录失效。',
      };
    }
    return TestResultSchema.parse({
      ...result,
      ...(connection ? { connection } : {}),
      routeStatus:
        effective.mode === 'direct'
          ? 'direct'
          : effective.mode === 'proxy' &&
              connection &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(effective.proxyUrl!).hostname) &&
              connection.peerPort ===
                Number(
                  new URL(effective.proxyUrl!).port ||
                    (new URL(effective.proxyUrl!).protocol === 'https:' ? 443 : 80),
                ) &&
              ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(connection.peerAddress)
            ? 'proxy-observed'
            : 'unconfirmed',
      effective,
      observedAt: new Date().toISOString(),
      durationMs: Date.now() - begin,
    });
  }
}
