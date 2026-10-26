import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { AgentCatalogService } from './agent-catalog.js';
import { AgentInstallationsService } from './agent-installations.js';
import { packagePlan, type installAgentPackage } from './agent-package-install.js';
const entry = {
  id: 'test-worker',
  name: 'Test Worker',
  version: '1.0.0',
  description: 'A deterministic worker',
  license_url: 'https://example.com/LICENSE',
  distribution: {
    binary: {
      'windows-x86_64': {
        archive: 'https://example.com/worker.zip',
        cmd: 'worker.exe',
        sha256: 'a'.repeat(64),
      },
    },
  },
};

it('isolates install, retries a failed install and interrupted check, reuses registration, and leaves login to agent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-install-')),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const catalog = new AgentCatalogService(
    undefined,
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0.0', agents: [entry] }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  await catalog.refresh();
  const installer = vi
    .fn<typeof installAgentPackage>()
    .mockImplementationOnce(async ({ directory, phase, progress }) => {
      phase('downloading', 'Downloading fixture');
      progress?.({ receivedBytes: 50, totalBytes: 100 });
      expect(service.list()[0]).toMatchObject({
        directory,
        progress: { receivedBytes: 50, totalBytes: 100 },
      });
      expect(storage.repositories.agentInstallations.list()[0]?.directory).toBe(directory);
      phase('installing', 'Installing fixture');
      expect(service.list()[0]?.progress).toBeUndefined();
      throw new Error('network failed');
    })
    .mockResolvedValue({
      type: 'acp-stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/client-worker-agent.mjs', import.meta.url))],
    });
  const options = {
    storage,
    catalog,
    agents: runtime.agentControl,
    network: runtime.network,
    root: join(root, 'agents'),
    releaseRoot: root,
    installPackage: installer,
  };
  let service = new AgentInstallationsService(options);
  try {
    const plan = service.plan(entry.id);
    expect(plan.integrity).toBe('sha256');
    expect(plan.installationRoot).toBe(join(root, 'agents'));
    const input = {
      requestId: randomUUID(),
      entryId: entry.id,
      version: entry.version,
      planHash: plan.planHash,
      confirmed: true,
    };
    const first = service.start(input);
    expect(service.start(input).id).toBe(first.id);
    await service.settle();
    expect(service.list()[0]?.state).toBe('failed');
    const failedDirectory = service.list()[0]?.directory;
    expect(failedDirectory).toContain(first.id);
    expect(service.list()[0]?.progress).toBeUndefined();
    expect(runtime.agentControl.list()).toHaveLength(0);
    service.retry(first.id);
    await service.settle();
    const ready = storage.repositories.agentInstallations.get(first.id)!;
    expect(ready.state).toBe('ready');
    expect(ready.directory).not.toBe(failedDirectory);
    expect(ready.agentId).toBeDefined();
    expect(installer).toHaveBeenCalledTimes(2);
    const agent = runtime.agentControl.list()[0]!;
    expect(agent.definition.auth).toEqual({ mode: 'agent-managed' });
    expect(agent.definition.orchestration.canBeBoss).toBe(false);
    expect(agent.definition.runtime.args[0]).toContain('client-worker-agent');
    storage.repositories.agentInstallations.upsert({ ...ready, state: 'checking' });
    service = new AgentInstallationsService(options);
    expect(service.list()[0]?.state).toBe('failed');
    expect(service.list()[0]?.directory).toBe(ready.directory);
    service.retry(first.id);
    await service.settle();
    expect(service.list()[0]?.state).toBe('ready');
    expect(installer).toHaveBeenCalledTimes(2);
    expect(runtime.agentControl.list()).toHaveLength(1);
    // Simulate losing the catalog after restart: connection retries use the
    // durable package entry, including a restart before initial registration.
    options.catalog = new AgentCatalogService();
    storage.repositories.agentInstallations.upsert({
      ...storage.repositories.agentInstallations.get(first.id)!,
      state: 'needs-attention',
    });
    service = new AgentInstallationsService(options);
    service.retry(first.id);
    await service.settle();
    expect(service.list()[0]?.state).toBe('ready');
    expect(installer).toHaveBeenCalledTimes(2);
    storage.repositories.agentDefinitions.delete(ready.agentId!);
    storage.repositories.agentInstallations.upsert({
      ...storage.repositories.agentInstallations.get(first.id)!,
      state: 'failed',
    });
    service.retry(first.id);
    await service.settle();
    expect(service.list()[0]?.state).toBe('ready');
    expect(installer).toHaveBeenCalledTimes(2);
    const legacy = {
      ...storage.repositories.agentInstallations.get(first.id)!,
      state: 'failed' as const,
    };
    delete legacy.package;
    storage.repositories.agentInstallations.upsert(legacy);
    service.retry(first.id);
    await service.settle();
    expect(service.list()[0]?.state).toBe('ready');
    expect(storage.repositories.agentInstallations.get(first.id)?.package?.origin).toBe(
      'registered-entry',
    );
  } finally {
    await service.settle();
    await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
it('selects fixed packages only and reports unsupported platforms honestly', () => {
  const npm = { ...entry, distribution: { npx: { package: '@example/worker@1.2.3' } } };
  expect(packagePlan(npm, 'windows-x86_64', true).distribution.kind).toBe('npm');
  expect(() =>
    packagePlan(
      { ...npm, distribution: { npx: { package: '@example/worker@latest' } } },
      'windows-x86_64',
      true,
    ),
  ).toThrow();
  expect(() => packagePlan(npm, 'windows-x86_64', false)).toThrow();
  expect(() => packagePlan(entry, 'linux-x86_64', true)).toThrow();
  expect(
    packagePlan(
      {
        ...entry,
        distribution: {
          binary: {
            'windows-x86_64': { archive: 'https://example.com/package.zip', cmd: 'worker.exe' },
          },
        },
      },
      'windows-x86_64',
      true,
    ).integrity,
  ).toBe('https-source');
});
