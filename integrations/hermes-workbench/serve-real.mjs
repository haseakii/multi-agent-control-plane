import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPromptBudget } from './prompt-budget.mjs';
import { uiBuildId } from './ui-build.mjs';
import { homedir } from 'node:os';
import { observePermissions } from './permission-diagnostics.mjs';
import { runWorkbenchInstance } from './instance-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = path.join(root, '.run/hermes-integration');
const run = path.join(base, 'real-20261023');
for (const folder of ['data', 'temp']) fs.mkdirSync(path.join(run, folder), { recursive: true });
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { LocalRunner } = await load('packages/runner/dist/index.js');
const { openSqliteStorage } = await load('packages/storage/dist/index.js');
const { createControlPlaneRuntime } = await load('apps/server/dist/runtime-composition.js');
const { readControlCenterSnapshot } = await load('apps/server/dist/control-center.js');
const { buildServer } = await load('apps/server/dist/server.js');
const { AgentDefinitionSchema } = await load('packages/core/dist/index.js');
const { acquireInstanceLock } = await load('apps/server/dist/release-config.js');
const { closeHttpServer } = await load('apps/server/dist/http-shutdown.js');
await runWorkbenchInstance({
  run, data: path.join(run, 'data'), url: 'http://127.0.0.1:8047', acquireLock: acquireInstanceLock,
}, async (instance) => {
  // The 3-turn acceptance ledger is historical evidence, not the daily product quota.
  // Daily calls are recorded independently, without silently resetting that ledger.
  const usage = createPromptBudget(path.join(run, 'daily-prompt-usage.json'), null);
  const native = new LocalRunner({ id: 'hermes-real', inheritedEnvironmentKeys: [] });
  const actors = new Map();
  const handles = [];
  let closing = false;
  const definitionsPath = path.join(root, '.run/collaboration-integration-20261022/real-pair');
  const runtimeKey = (definition) =>
    JSON.stringify([path.normalize(definition.command).toLowerCase(), definition.args ?? []]);
  // Local adapter profiles are keyed by the approved launch entry, not a domain role.
  // Additional agents use their own inherited home and explicit environment allowlist.
  const bootstrapDefinitions = [];
  const profiles = new Map();
  for (const [id, profile] of [
    [
      'codex-acceptance',
      {
        env: { CODEX_HOME: path.join(root, '.data/codex-acp-preflight/agent-profile/codex') },
        authMethod: 'chat-gpt',
      },
    ],
    ['antigravity-acceptance', { env: {}, authMethod: 'oauth-personal' }],
  ]) {
    try {
      const definition = AgentDefinitionSchema.parse(
        JSON.parse(fs.readFileSync(path.join(definitionsPath, `${id}.json`), 'utf8')),
      );
      if (definition.id !== id) throw new Error('Bootstrap definition identity changed.');
      bootstrapDefinitions.push(definition);
      profiles.set(runtimeKey(definition.runtime), profile);
    } catch {
      // Optional first-run seeds must not prevent saved members or an empty workbench
      // from starting. Do not infer an authentication profile from a member's name/ID.
      console.error(JSON.stringify({ agentId: id, status: 'bootstrap-unavailable' }));
    }
  }
  const userHome = process.env.USERPROFILE ?? homedir();
  const env = {
    SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
    WINDIR: process.env.WINDIR ?? 'C:/Windows',
    PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
    USERPROFILE: userHome,
    HOME: userHome,
    APPDATA: process.env.APPDATA ?? path.join(userHome, 'AppData/Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(userHome, 'AppData/Local'),
    TEMP: path.join(run, 'temp'),
    TMP: path.join(run, 'temp'),
  };
  const runner = {
    descriptor: () => native.descriptor(),
    async spawn(spec) {
      if (closing || instance.stopping) throw new Error('Workbench is stopping.');
      const profile = profiles.get(runtimeKey(spec));
      const handle = await native.spawn({
        ...spec,
        env: {
          ...env,
          ...profile?.env,
          ...spec.env,
        },
      });
      if (closing || instance.stopping) {
        await native.stop(handle);
        throw new Error('Workbench is stopping.');
      }
      actors.set(handle.id, spec.agentId ?? 'unattributed');
      handles.push(handle);
      fs.writeFileSync(path.join(run, 'owned-processes.json'), JSON.stringify(handles, null, 2));
      return handle;
    },
    transport(handle) {
      const transport = native.transport(handle);
      return {
        readable:
          process.env.HERMES_PERMISSION_DIAGNOSTICS === '1'
            ? observePermissions(
                transport.readable,
                path.join(run, 'permission-diagnostics.jsonl'),
                actors.get(handle.id),
              )
            : transport.readable,
        writable: usage.wrap(transport.writable, actors.get(handle.id)),
      };
    },
    stop: (...a) => native.stop(...a),
    status: (...a) => native.status(...a),
    wait: (...a) => native.wait(...a),
    events: (...a) => native.events(...a),
    writeStdin: (...a) => native.writeStdin(...a),
    endStdin: (...a) => native.endStdin(...a),
  };
  instance.assertRunning();
  const storage = instance.acquireResource(
    () => openSqliteStorage({ filename: path.join(run, 'data/state.sqlite') }),
    (storage) => storage.close(),
  );
  const runtime = instance.acquireResource(() => createControlPlaneRuntime({
    storage,
    runner,
    workspaceRoot: path.join(run, 'data/workspaces'),
    artifactRoot: path.join(run, 'data/artifacts'),
    // Daily work uses the engine's normal timeout, not the short acceptance deadline.
  }), () => stopRuntime());
  let memberChecks = Promise.resolve();
  let runtimeShutdown;
  const stopRuntime = () => runtimeShutdown ??= (async () => {
    closing = true;
    const results = await Promise.allSettled([runtime.close(), ...handles.map((handle) => native.stop(handle))]);
    await memberChecks;
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Runtime shutdown incomplete.');
  })();
  const app = instance.acquireResource(() => buildServer({
    agentControl: runtime.agentControl,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
    webRoot: path.join(base, 'web-dist'),
    controlCenter: () =>
      readControlCenterSnapshot(
        storage,
        (id) => runtime.agentControl.state(id),
        (id) => runtime.directoryBindings.confirmationVersion(id),
        (a) => runtime.approvalDecisionEligibility(a),
      ),
  }), (app) => closeHttpServer(app));
  app.get('/api/workbench', async () => ({
    mode: 'real',
    profile: 'daily',
    uiBuildId: uiBuildId(base),
    promptsUsed: usage.read().used,
  }));
  app.addHook('preClose', stopRuntime);
  instance.assertRunning();
  const url = await app.listen({ host: '127.0.0.1', port: 8047 });
  runtime.setBridgeBaseUrl(url);
  instance.assertRunning();
  {
    const seeded = path.join(run, 'agents-seeded.json');
    if (!fs.existsSync(seeded)) {
      if (storage.repositories.agentDefinitions.list().length === 0)
        for (const definition of bootstrapDefinitions) runtime.agentControl.create(definition);
      fs.writeFileSync(seeded, JSON.stringify({ initializedAt: new Date().toISOString() }));
    }
    instance.ready({ run });
    console.log(`Hermes real workbench: ${url}`);
  }
  // Publish the usable workbench before checking external processes. A slow login
  // must not hold the launcher, saved conversations, or draft input hostage.
  memberChecks = (async () => {
    for (const definition of storage.repositories.agentDefinitions.list()) {
      if (closing || instance.stopping) break;
      const id = definition.id;
      if (!definition.enabled) continue;
      try {
        const probe = await runtime.agentControl.probe(id);
        if (closing || instance.stopping) break;
        if (probe.readiness.runtime !== 'ready') throw Error(`Agent unavailable: ${id}`);
        const profile = profiles.get(runtimeKey(definition.runtime));
        const auth =
          profile && probe.readiness.auth !== 'ready'
            ? await runtime.agentControl.authenticate(id, profile.authMethod)
            : probe;
        if (!closing) console.log(JSON.stringify({ agentId: id, ...auth.readiness }));
      } catch {
        if (!closing) console.error(JSON.stringify({ agentId: id, status: 'needs-attention' }));
      }
    }
  })();
});
