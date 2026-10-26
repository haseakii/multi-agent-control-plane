import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { openSqliteStorage } from '../packages/storage/dist/index.js';
import { createControlPlaneRuntime } from '../apps/server/src/runtime-composition.js';
import { AgentCatalogService } from '../apps/server/src/agent-catalog.js';
import { AgentInstallationsService } from '../apps/server/src/agent-installations.js';
import { installAgentPackage } from '../apps/server/src/agent-package-install.js';
import { runInstallProcess } from '../apps/server/src/agent-install-process.js';

// Explicit live acceptance run: real public packages and ACP initialization; no model prompts or login.
const ids = process.argv.slice(2);
const selected = ids.length
  ? ids
  : ['codex-acp', 'codebuddy-code', 'antigravity-acp', 'claude-acp'];
const cache = resolve('node_modules/.cache/acp-compat');
const root = resolve(process.env.ACP_TEST_ROOT ?? join(cache, 'live'));
const releaseRoot = process.env.ACP_TEST_RELEASE_ROOT;
if (!releaseRoot)
  throw new Error('Set ACP_TEST_RELEASE_ROOT to the installed release containing runtime/npm.');
mkdirSync(root, { recursive: true });
mkdirSync(join(root, 'runtime'), { recursive: true });
if (!existsSync(join(root, 'runtime/node.exe')))
  copyFileSync(process.execPath, join(root, 'runtime/node.exe'));
const registry = JSON.parse(readFileSync(join(cache, 'registry.json'), 'utf8'));
const storage = openSqliteStorage({ filename: join(root, 'acceptance.sqlite') });
const runtime = createControlPlaneRuntime({
  storage,
  workspaceRoot: join(root, 'workspaces'),
  artifactRoot: join(root, 'artifacts'),
});
const networkFetch = runtime.network.fetch.bind(runtime.network);
const packageCache: Record<string, string> = process.env.ACP_TEST_PACKAGE_CACHE
  ? JSON.parse(readFileSync(process.env.ACP_TEST_PACKAGE_CACHE, 'utf8'))
  : {};
runtime.network.fetch = async (url, init) => {
  const source = String(url);
  const cachedPackage = packageCache[source];
  if (cachedPackage) {
    // Production installation still verifies the lockfile's full SHA-512 digest.
    return new Response(Readable.toWeb(createReadStream(cachedPackage)) as ReadableStream, {
      headers: { 'content-length': String(statSync(cachedPackage).size) },
    });
  }
  const archive = join(cache, 'antigravity-1.4.3.zip');
  // A previously downloaded official asset is still SHA-256 checked by the production installer.
  if (
    source ===
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-x86_64.zip' &&
    existsSync(archive) &&
    existsSync(archive + '.verified')
  ) {
    return new Response(Readable.toWeb(createReadStream(archive)) as ReadableStream, {
      headers: { 'content-length': String(statSync(archive).size) },
    });
  }
  return networkFetch(url, init);
};
const catalog = new AgentCatalogService(
  undefined,
  async () =>
    new Response(JSON.stringify(registry), { headers: { 'content-type': 'application/json' } }),
);
await catalog.refresh();
const service = new AgentInstallationsService({
  storage,
  catalog,
  agents: runtime.agentControl,
  network: runtime.network,
  root: join(root, 'agents'),
  releaseRoot,
  installPackage: async (options) => {
    try {
      return await installAgentPackage({
        ...options,
        ...(process.env.ACP_TEST_NPM_CACHE
          ? {
              run: (command, args, config) =>
                runInstallProcess(command, args, {
                  ...config,
                  env: { ...config.env, npm_config_cache: process.env.ACP_TEST_NPM_CACHE },
                }),
            }
          : {}),
      });
    } catch (error) {
      // Local opt-in diagnostics only, never forwarded through the product API.
      const failure = error as Error & { code?: string };
      console.error(
        JSON.stringify({
          product: options.plan.entryId,
          failure: failure.name,
          code: failure.code,
          message: failure.message.slice(0, 500),
        }),
      );
      throw error;
    }
  },
});
const results: unknown[] = [];
try {
  for (const id of selected) {
    const plan = service.plan(id);
    const record = service.start({
      requestId: randomUUID(),
      entryId: id,
      version: plan.version,
      planHash: plan.planHash,
      confirmed: true,
    });
    let last = '';
    const status = setInterval(() => {
      const row = service.list().find((r) => r.id === record.id);
      if (!row) return;
      const text = JSON.stringify({
        product: id,
        state: row.state,
        message: row.message,
        progress: row.progress,
      });
      if (text !== last) {
        last = text;
        console.log(text);
      }
    }, 10000);
    try {
      await service.settle();
    } finally {
      clearInterval(status);
    }
    const row = service.list().find((r) => r.id === record.id)!;
    const member = runtime.agentControl.list().find((a) => a.definition.id === row.agentId);
    const result = {
      product: id,
      version: plan.version,
      state: row.state,
      message: row.message,
      directory: row.directory,
      runtime: member?.readiness.runtime,
      auth: member?.readiness.auth,
      authMethods: member?.authMethods,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
  }
} finally {
  await service.settle();
  await runtime.close();
  storage.close();
}
if (results.some((result) => (result as { state: string }).state !== 'ready')) process.exitCode = 1;
