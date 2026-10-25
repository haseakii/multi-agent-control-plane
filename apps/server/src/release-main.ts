import { createWriteStream } from 'node:fs';
import { mkdir, access } from 'node:fs/promises';
import { AgentCatalogService, FileCatalogCache } from './agent-catalog.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { openSqliteStorage, type SqliteStorage } from '@control-plane/storage';
import { getFleetMcpStdioProxyPath } from '@control-plane/fleet-mcp';
import { readReleaseConfig, acquireInstanceLock } from './release-config.js';
import { readControlCenterSnapshot } from './control-center.js';
import { createControlPlaneRuntime, type ControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { runMaintenanceCommand } from './release-maintenance.js';
import { closeHttpServer } from './http-shutdown.js';
import { startupFailureDiagnostic, type StartupStage } from './startup-diagnostic.js';
import { readReleaseWorkbench } from './release-workbench.js';
import { readClientAccessFile } from './client-gateway.js';
import { createInstanceControl, stopInstance } from './instance-control.js';
import { warmStartupAgents } from './startup-agents.js';
import { deploymentContext, waitForDeployment } from './deployment-context.js';
import { ExternalClientsService } from './external-clients.js';
import { AgentInstallationsService } from './agent-installations.js';

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function startRelease(args: string[]) {
  let startupPort: number | undefined;
  let startupStage: StartupStage = 'config';
  let releaseLock: (() => void) | undefined;
  let storage: SqliteStorage | undefined;
  let runtime: ControlPlaneRuntime | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let log: ReturnType<typeof createWriteStream> | undefined;
  let closeControl: (() => Promise<void>) | undefined;
  const warmupStop = new AbortController();
  let warmup: Promise<void> | undefined;
  try {
    if (args.length && !(args.length === 2 && args[0] === '--config'))
      throw new Error('Usage: start.cmd [--config ABSOLUTE_CONFIG_PATH]');
    const configPath = args[1] ?? join(bundleRoot, 'config.json');
    const config = readReleaseConfig(configPath);
    const deployment = deploymentContext(process.env.CONTROL_PLANE_DEPLOYMENT_CONTEXT);
    startupPort = config.port;
    startupStage = 'assets';
    const webRoot = join(bundleRoot, 'apps/web/dist');
    await access(join(webRoot, 'index.html'));
    const workbench = readReleaseWorkbench(webRoot);
    await access(getFleetMcpStdioProxyPath());
    startupStage = 'listen';
    await new Promise<void>((ok, no) => {
      const probe = createServer();
      probe.once('error', no);
      probe.listen(config.port, config.host, () =>
        probe.close((error) => (error ? no(error) : ok())),
      );
    });
    startupStage = 'data';
    releaseLock = acquireInstanceLock(config.dataDir, configPath);
    await mkdir(join(config.dataDir, 'logs'), { recursive: true });
    log = createWriteStream(join(config.dataDir, 'logs/server.log'), { flags: 'a' });
    await new Promise<void>((ok, no) => {
      log!.once('open', () => ok());
      log!.once('error', no);
    });
    storage = openSqliteStorage({ filename: join(config.dataDir, 'control-plane.sqlite') });
    runtime = createControlPlaneRuntime({
      storage,
      artifactRoot: join(config.dataDir, 'artifacts'),
      workspaceRoot: join(config.dataDir, 'workspaces'),
    });
    const activeRuntime = runtime;
    const activeStorage = storage;
    const readLegacy = config.clientAccessFile
      ? readClientAccessFile(config.clientAccessFile)
      : () => ({ version: 1, clients: [] });
    const externalClients = deployment
      ? new ExternalClientsService({
          storage,
          runtime,
          installationFile: join(dirname(deployment.operationFile), 'installation.json'),
          baseUrl: `http://${config.host}:${config.port}`,
          readLegacy,
        })
      : undefined;
    const agentCatalog = new AgentCatalogService(
      new FileCatalogCache(join(config.dataDir, 'cache/agent-catalog.json')),
      runtime.network.fetch,
    );
    const agentInstallations = deployment
      ? new AgentInstallationsService({
          storage,
          catalog: agentCatalog,
          agents: runtime.agentControl,
          network: runtime.network,
          root: join(dirname(deployment.operationFile), 'agents'),
          releaseRoot: bundleRoot,
        })
      : undefined;
    app = buildServer({
      ...(externalClients ? { externalClients } : {}),
      ...(agentInstallations ? { agentInstallations } : {}),
      ...(deployment ? { deployment } : {}),
      fastify: { logger: { level: config.logLevel, stream: log } },
      webRoot,
      agentControl: runtime.agentControl,
      agentCatalog,
      taskControl: runtime,
      fleetGateway: runtime.fleetGateway,
      ...(config.clientAccessFile || externalClients
        ? {
            clientGateway: {
              storage,
              runtime,
              readAccess: externalClients?.readAccess ?? readLegacy,
            },
          }
        : {}),
      controlCenter: (options) =>
        readControlCenterSnapshot(
          activeStorage,
          (id) => activeRuntime.agentControl.state(id),
          (id) => activeRuntime.directoryBindings.confirmationVersion(id),
          (approval) => activeRuntime.approvalDecisionEligibility(approval),
          options,
        ),
    });
    if (workbench) app.get('/api/workbench', async () => workbench);
    app.addHook('preClose', async () => {
      warmupStop.abort();
      await closeControl?.();
      closeControl = undefined;
      await activeRuntime.close();
      await warmup;
    });
    app.addHook('onClose', async () => {
      activeStorage.close();
      releaseLock?.();
      releaseLock = undefined;
      log?.end();
    });
    startupStage = 'listen';
    const address = await app.listen({ host: config.host, port: config.port });
    runtime.setBridgeBaseUrl(address);
    const health = (await fetch(`${address}/health`).then((response) => response.json())) as {
      status?: string;
      service?: string;
    };
    if (health.status !== 'ok' || health.service !== 'multi-agent-control-plane')
      throw new Error('Startup health check failed.');
    console.log(
      `Control Plane ready: ${address}\nData: ${config.dataDir}\nLog: ${join(config.dataDir, 'logs/server.log')}\nStop: use stop --config with this configuration, or Ctrl+C in foreground mode.`,
    );
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void closeHttpServer(app!).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    closeControl = await createInstanceControl(config.dataDir, stop);
    // Serve history and register normal shutdown before any network-dependent authentication.
    warmup = waitForDeployment(deployment, warmupStop.signal).then(() =>
      warmupStop.signal.aborted
        ? undefined
        : warmStartupAgents(config.startupAgents, activeRuntime.agentControl, {
            signal: warmupStop.signal,
            report: (agentId, state) =>
              console.log(
                `${agentId}: ${
                  state === 'ready'
                    ? '已有登录就绪'
                    : state === 'retrying'
                      ? '登录服务暂时未响应，正在自动重试一次'
                      : '启动检查未完成，请在协作成员中查看原因'
                }`,
              ),
          }),
    );
  } catch (error) {
    const portConflict = startupFailureDiagnostic(error, startupPort, startupStage);
    if (portConflict) console.error(portConflict);
    else
      console.error(
        'Control Plane startup failed:',
        error instanceof Error ? error.message : String(error),
      );
    process.exitCode = 1;
    if (app) await closeHttpServer(app);
    else {
      await runtime?.close();
      storage?.close();
      releaseLock?.();
      log?.end();
    }
  }
}
try {
  const args = process.argv.slice(2);
  if (args[0] === 'stop') {
    if (args.length !== 3 || args[1] !== '--config')
      throw new Error('Usage: stop --config CONFIG_PATH');
    await stopInstance(readReleaseConfig(args[2]!).dataDir);
    console.log('工作台已正常停止；下次从 Codex 发起操作时将自动启动。');
  } else if (!(await runMaintenanceCommand(args, bundleRoot))) await startRelease(args);
} catch (error) {
  console.error(
    'Control Plane maintenance failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
