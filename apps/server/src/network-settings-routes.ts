import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { NetworkSettingsError, type NetworkSettingsService } from './network-settings.js';
import { SaveNetworkSettingsSchema } from '@control-plane/core';
import { detectLocalProxy } from './agent-auto-discovery.js';
export function registerNetworkSettingsRoutes(
  app: FastifyInstance,
  service: NetworkSettingsService,
) {
  const fail = (reply: FastifyReply, error: unknown) =>
    error instanceof NetworkSettingsError
      ? reply.code(error.statusCode).send({ error: error.message })
      : reply.code(error instanceof z.ZodError ? 400 : 409).send({
          error:
            '网络设置未能确认。请核对 HTTP/HTTPS 地址、版本与成员列表；原设置保持原样。地址不可包含用户名或密码。',
        });
  app.get('/api/system/network', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return service.view();
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get('/api/system/network/proxy-detection', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return await detectLocalProxy();
    } catch {
      return reply.send({ detected: false });
    }
  });
  app.patch('/api/system/network', async (request, reply) => {
    try {
      const input = SaveNetworkSettingsSchema.parse(request.body);
      const endpoints = [input.global, ...Object.values(input.members)]
        .filter((v) => v.mode === 'proxy')
        .map((v) => new URL(v.proxyUrl!));
      const local = new URL('http://' + request.headers.host);
      if (endpoints.some((url) => url.hostname === local.hostname && url.port === local.port))
        throw new NetworkSettingsError(400, '代理地址不能指向工作台自身的服务端口。');
      return service.save(input);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/system/network/test', async (request, reply) => {
    try {
      return await service.test(request.body);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
