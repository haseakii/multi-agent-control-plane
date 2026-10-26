import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter, resolve, basename } from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { AgentCatalogService } from './agent-catalog.js';
import { createLocalIntegrations } from './local-integrations.js';
import { preferBundledRuntime } from './bundled-runtime.js';
import { buildServer } from './server.js';

function removeFixture(root: string) {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
  expect(basename(root)).toMatch(/^(local-integrations|bundled-runtime)-/);
  rmSync(root, { recursive: true, force: true });
}

it('provides downloads and working MCP tools without a deployment manager', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-integrations-'));
  const storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const catalog = new AgentCatalogService(
    undefined,
    async () =>
      new Response(
        JSON.stringify({
          version: '1.0.0',
          agents: [
            {
              id: 'fixture',
              name: 'Fixture',
              version: '1.0.0',
              description: 'Test only',
              license_url: 'https://example.com/LICENSE',
              distribution: {
                binary: {
                  'windows-x86_64': {
                    archive: 'https://example.com/fixture.zip',
                    cmd: './fixture.exe',
                  },
                },
                npx: { package: 'fixture@1.0.0' },
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await catalog.refresh();
  const local = createLocalIntegrations({
    storage,
    runtime,
    catalog,
    dataDir: root,
    releaseRoot: root,
    baseUrl: 'http://127.0.0.1:0',
  });
  const app = buildServer({
    ...local,
    agentControl: runtime.agentControl,
    agentCatalog: catalog,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
    clientGateway: { storage, runtime, readAccess: local.externalClients.readAccess },
  });
  let client: Client | undefined;
  try {
    runtime.createProject({ id: 'p', name: 'Local project' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    local.setBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
    expect((await app.inject('/api/agent-installations')).statusCode).toBe(200);
    expect((await app.inject('/api/agent-catalog')).json().installationSupported).toBe(true);
    expect((await app.inject('/api/agent-catalog/fixture/install-plan')).statusCode).toBe(200);
    expect((await app.inject('/api/external-clients')).json().projects).toHaveLength(1);
    const config = local.externalClients.create({
      requestId: randomUUID(),
      name: 'Reader',
      target: 'generic',
      profile: 'read',
      projects: [{ projectId: 'p' }],
    });
    expect(config.server.args).not.toContain('--installation');
    expect(JSON.parse(readFileSync(config.server.args.at(-1)!, 'utf8'))).not.toHaveProperty(
      'start',
    );
    client = new Client({ name: 'local-integration-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ ...config.server, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('collaboration_list_projects');
    expect(tools).not.toContain('collaboration_submit_task');
    const result = await client.callTool({ name: 'collaboration_list_projects', arguments: {} });
    expect(JSON.stringify(result)).toContain('Local project');
    expect(storage.repositories.tasks.list()).toHaveLength(0);
  } finally {
    await client?.close();
    await app.close();
    await runtime.close();
    storage.close();
    removeFixture(root);
  }
});

it('prefers only a complete private runtime and preserves the rest of PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'bundled-runtime-'));
  try {
    const environment = { Path: 'old-nvm' };
    expect(preferBundledRuntime(root, environment)).toBe(false);
    for (const file of [
      'node.exe',
      'npm.cmd',
      'npx.cmd',
      'npm/bin/npm-cli.js',
      'npm/bin/npx-cli.js',
    ]) {
      const filename = join(root, 'runtime', file);
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, 'fixture');
    }
    expect(preferBundledRuntime(root, environment)).toBe(true);
    preferBundledRuntime(root, environment);
    expect(environment.Path).toBe(join(root, 'runtime') + delimiter + 'old-nvm');
  } finally {
    removeFixture(root);
  }
});
