import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { NetworkSettingsSchema } from '@control-plane/core';
import { applyNetworkEnvironment, fetchUsingNetwork, resolveNetwork } from './network-settings.js';
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function serve(listener: Parameters<typeof createServer>[0]) {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
  };
}
const settings = (proxyUrl: string) =>
  NetworkSettingsSchema.parse({
    revision: 1,
    updatedAt: null,
    global: { mode: 'proxy', proxyUrl },
    members: {
      a: { mode: 'inherit' },
      b: { mode: 'proxy', proxyUrl: '127.0.0.1:7999' },
      c: { mode: 'direct' },
    },
  });
it('resolves each member independently and clears conflicting proxy environment variables without changing other values', () => {
  const saved = settings('127.0.0.1:7897');
  const a = resolveNetwork(saved, 'a', 1),
    b = resolveNetwork(saved, 'b', 1),
    c = resolveNetwork(saved, 'c', 1);
  expect(a).toMatchObject({
    source: 'global',
    mode: 'proxy',
    proxyUrl: 'http://127.0.0.1:7897',
    enforcementMode: 'cooperative',
  });
  expect(b.proxyUrl).toBe('http://127.0.0.1:7999');
  expect(c.mode).toBe('direct');
  const base = {
    HTTPS_PROXY: 'http://old.invalid',
    https_proxy: 'http://different.invalid',
    ALL_PROXY: 'http://old.invalid',
    KEEP: 'unchanged',
  };
  expect(applyNetworkEnvironment(base, a)).toMatchObject({
    HTTPS_PROXY: a.proxyUrl,
    https_proxy: a.proxyUrl,
    KEEP: 'unchanged',
    NODE_USE_ENV_PROXY: '1',
  });
  const direct = applyNetworkEnvironment(base, c);
  expect(direct.HTTPS_PROXY).toBe('');
  expect(direct.https_proxy).toBe('');
  expect(direct.ALL_PROXY).toBe('');
  expect(direct.NO_PROXY).toContain('127.0.0.1');
  expect(direct.KEEP).toBe('unchanged');
  const original = resolveNetwork(
    NetworkSettingsSchema.parse({
      revision: 0,
      updatedAt: null,
      global: { mode: 'unmanaged' },
      members: {},
    }),
    'a',
  );
  expect(applyNetworkEnvironment(base, original)).toEqual(base);
  const changed = settings('127.0.0.1:7888');
  expect(resolveNetwork(changed, 'a', 2).fingerprint).not.toBe(a.fingerprint);
  expect(resolveNetwork(changed, 'b', 2).fingerprint).toBe(b.fingerprint);
});
it('routes an owned external HTTP request through the chosen real proxy and keeps local requests direct', async () => {
  const observed: string[] = [];
  const proxy = await serve((req, res) => {
    observed.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end('{"via":"fixture-proxy"}');
  });
  const effective = resolveNetwork(settings(proxy.url), undefined, 1);
  const response = await fetchUsingNetwork(
    'http://provider.invalid/public',
    { signal: AbortSignal.timeout(3000) },
    effective,
  );
  expect(await response.json()).toEqual({ via: 'fixture-proxy' });
  expect(observed).toEqual(['http://provider.invalid/public']);
  const target = await serve((_req, res) => {
    res.end('local');
  });
  const local = await fetchUsingNetwork(
    target.url,
    { signal: AbortSignal.timeout(3000) },
    effective,
  );
  expect(await local.text()).toBe('local');
  expect(observed).toHaveLength(1);
});
it('uses CONNECT for an HTTPS target and reports proxy rejection without direct fallback', async () => {
  const proxy = await serve((_req, res) => res.end());
  const targets: string[] = [];
  proxy.server.on('connect', (req, socket) => {
    targets.push(req.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await expect(
    fetchUsingNetwork(
      'https://provider.invalid/private',
      { signal: AbortSignal.timeout(3000) },
      resolveNetwork(settings(proxy.url), undefined, 1),
    ),
  ).rejects.toThrow();
  expect(targets).toEqual(['provider.invalid:443']);
});
