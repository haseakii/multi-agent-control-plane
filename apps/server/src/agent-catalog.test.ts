import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCatalogService,
  CatalogSchema,
  FileCatalogCache,
  OFFICIAL_CATALOG_URL,
  CATALOG_LIMIT,
} from './agent-catalog.js';
import { AgentControlService } from './agent-control.js';
import { openSqliteStorage } from '@control-plane/storage';
import { buildServer } from './server.js';

const entry = () => ({
  id: 'test-agent',
  name: '<img src=x onerror=alert(1)>',
  description: 'Untrusted metadata',
  version: '1.0.0',
  license_url: 'https://example.com/license',
  distribution: {
    binary: {
      'windows-x86_64': {
        archive: 'https://example.com/not-downloaded.zip',
        cmd: './untrusted.exe',
        env: { DANGEROUS: 'never imported' },
      },
    },
    npx: { package: 'example@1.0.0' },
    uvx: { package: 'example==1.0.0' },
  },
});
const document = () => ({ version: '1.0.0', agents: [entry()] });
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('official catalog contract and inert cache', () => {
  it('accepts binary/npx/uvx and absent checksum, rejecting malformed contracts and duplicate ids', () => {
    expect(
      CatalogSchema.parse(document()).agents[0]?.distribution.binary?.['windows-x86_64']?.sha256,
    ).toBeUndefined();
    for (const value of [
      { version: '2.0.0', agents: [] },
      { version: '1.0.0', agents: [entry(), entry()] },
      { version: '1.0.0', agents: [{ ...entry(), distribution: { shell: 'execute' } }] },
      {
        version: '1.0.0',
        agents: [{ ...entry(), distribution: { binary: { 'windows-x86_64': { cmd: 'x' } } } }],
      },
      { version: '1.0.0', agents: [{ ...entry(), version: '1.0.0-preview.1' }] },
    ])
      expect(CatalogSchema.safeParse(value).success).toBe(false);
  });
  it('does no network at construction or snapshot; explicit refresh uses only fixed URL and rejects redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(document()));
    const catalog = new AgentCatalogService(undefined, request);
    expect(catalog.snapshot().entries).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect((await catalog.refresh()).entries).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      OFFICIAL_CATALOG_URL,
      expect.objectContaining({ redirect: 'manual' }),
    );
    request.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    );
    const failed = await catalog.refresh();
    expect(failed.entries).toHaveLength(1);
    expect(failed.error).toContain('保留原缓存');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('limits streamed and declared size and rejects invalid format without replacing a good cache', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(document()));
    const service = new AgentCatalogService(undefined, request);
    await service.refresh();
    for (const res of [
      new Response('x', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(CATALOG_LIMIT + 1),
        },
      }),
      new Response('x'.repeat(CATALOG_LIMIT + 1), {
        headers: { 'content-type': 'application/json' },
      }),
      response({ agents: [] }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
    ]) {
      request.mockResolvedValue(res);
      expect((await service.refresh()).entries).toHaveLength(1);
      expect(service.snapshot().error).not.toBeNull();
    }
  });
  it('aborts a stalled request and rejects overlapping refresh without queueing another download', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener('abort', () => reject(Error('aborted'))),
          ),
      );
    const service = new AgentCatalogService(undefined, request);
    const pending = service.refresh();
    await expect(service.refresh()).rejects.toThrow('BUSY');
    await vi.advanceTimersByTimeAsync(8001);
    expect((await pending).error).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('restores validated cache offline; corrupt caches and cache links are rejected, writes atomic data only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-catalog-'));
    roots.push(root);
    const file = join(root, 'cache.json');
    const cache = new FileCatalogCache(file);
    const service = new AgentCatalogService(
      cache,
      vi.fn<typeof fetch>().mockResolvedValue(response(document())),
    );
    await service.refresh();
    expect(JSON.parse(readFileSync(file, 'utf8')).registry.agents).toHaveLength(1);
    const request = vi.fn<typeof fetch>();
    expect(new AgentCatalogService(cache, request).snapshot().entries).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    writeFileSync(file, 'bad');
    expect(new AgentCatalogService(cache, request).snapshot().error).toContain('缓存无效');
    const link = join(root, 'linked');
    symlinkSync(root, link, 'junction');
    expect(() => new FileCatalogCache(join(link, 'cache.json')).read()).toThrow('links');
  });
});
it('binding validates existing paths, never executes metadata, remains disabled and keeps Host/Origin guard', async () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  const runtime = { probe: vi.fn(), authenticate: vi.fn() };
  const agents = new AgentControlService(storage, runtime);
  const catalog = new AgentCatalogService(
    undefined,
    vi.fn<typeof fetch>().mockResolvedValue(response(document())),
  );
  await catalog.refresh();
  const app = buildServer({ agentControl: agents, agentCatalog: catalog });
  const definition = {
    id: 'local-bound',
    name: 'Explicit local entry',
    enabled: true,
    runtime: { type: 'acp-stdio', command: process.execPath, args: [] },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  };
  try {
    const discovery = await app.inject({
      method: 'POST',
      url: '/api/agent-catalog/discover-local',
      payload: { entryId: 'test-agent' },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().note).toContain('未启动程序');
    expect(runtime.probe).not.toHaveBeenCalled();
    expect(runtime.authenticate).not.toHaveBeenCalled();
    for (const directory of ['relative/path', '\\\\server\\share', 'C:/bad\u0000path']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/agent-catalog/discover-local',
            payload: { entryId: 'test-agent', directory },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-catalog/discover-local',
          payload: { entryId: 'unknown' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-catalog/discover-local',
          payload: { entryId: 'test-agent', path: 'C:/secret' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-catalog/refresh',
          payload: { url: 'http://evil' },
        })
      ).statusCode,
    ).toBe(400);
    for (const headers of [
      { host: 'evil.test' },
      { host: 'localhost', origin: 'https://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect((await app.inject({ url: '/api/agent-catalog', headers })).statusCode).toBe(403);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agent-catalog/bind-local',
      payload: {
        entryId: 'test-agent',
        definition: { ...definition, runtime: { ...definition.runtime, command: 'missing.exe' } },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(agents.list()).toHaveLength(0);
    // Node-based adapters require an explicitly selected real JS entry, never catalog args.
    const good = {
      ...definition,
      runtime: {
        ...definition.runtime,
        args: [new URL('./agent-catalog.js', import.meta.url).pathname],
      },
    };
    // Use this test source as a regular file; no agent process is started.
    const { fileURLToPath } = await import('node:url');
    good.runtime.args = [fileURLToPath(new URL('./agent-catalog.test.ts', import.meta.url))];
    // Diagnostic intentionally only accepts real .js/.mjs/.cjs Node entrypoints.
    good.runtime.args = [fileURLToPath(new URL('../fixtures/worker-agent.mjs', import.meta.url))];
    for (const cwd of [process.execPath, process.execPath + '-missing-cwd']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/agent-catalog/bind-local',
        payload: {
          entryId: 'test-agent',
          definition: { ...good, runtime: { ...good.runtime, cwd } },
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(agents.list()).toHaveLength(0);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-catalog/bind-local',
      payload: { entryId: 'test-agent', definition: good },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().definition.enabled).toBe(false);
    expect(res.json().definition.runtime.args).toEqual(good.runtime.args);
    expect(res.json().definition.runtime.environmentAllowlist).toBeUndefined();
    expect(runtime.probe).not.toHaveBeenCalled();
    expect(runtime.authenticate).not.toHaveBeenCalled();
  } finally {
    await app.close();
    storage.close();
  }
});

it('accepts a generic registry with non-agent collections but drops them from the executable catalog', () => {
  const parsed = CatalogSchema.parse({
    ...document(),
    extensions: [{ id: 'not-an-agent', command: 'never-run', env: { DO_NOT_IMPORT: 'unused' } }],
  });
  expect(parsed.agents).toHaveLength(1);
  expect(parsed).not.toHaveProperty('extensions');
  expect(JSON.stringify(parsed)).not.toContain('never-run');
});
