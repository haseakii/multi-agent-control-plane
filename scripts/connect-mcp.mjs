// Register a local client against existing, explicitly selected projects. No provider credentials.
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ClientAccessFileSchema, clientToolDefinitions } from '../packages/fleet-mcp/dist/index.js';

const args = process.argv.slice(2),
  values = new Map();
for (let n = 0; n < args.length; n += 2) {
  if (!args[n]?.startsWith('--') || !args[n + 1] || values.has(args[n]))
    throw new Error('Expected distinct --option value pairs.');
  values.set(args[n], args[n + 1]);
}
for (const name of ['--url', '--client', '--project', '--access-file', '--connection'])
  if (!values.get(name)) throw new Error('Missing ' + name);
const url = new URL(values.get('--url'));
if (
  url.protocol !== 'http:' ||
  !['127.0.0.1', '[::1]'].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('Expected a loopback HTTP origin.');
const response = await fetch(new URL('/api/control-center', url), {
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('Workbench is unavailable.');
const snapshot = await response.json();
const projects = values
  .get('--project')
  .split(',')
  .map((projectId) => {
    const project = snapshot.projects.find((p) => p.id === projectId);
    const config = snapshot.workspaceConfigs.find((c) => c.id === projectId);
    if (!project || !config || !['task-local', 'git-worktree'].includes(config.mode))
      throw new Error('Choose an existing isolated project: ' + projectId);
    const binding = snapshot.directoryBindings.find((b) => b.id === config.sourceWorkspaceId);
    const info = binding ? statSync(binding.rootPath, { bigint: true }) : undefined;
    const version = binding
      ? createHash('sha256')
          .update(
            JSON.stringify([
              'client-workspace-v1',
              binding.id,
              binding.rootPath,
              String(info.dev),
              String(info.ino),
            ]),
          )
          .digest('hex')
      : undefined;
    return {
      projectId,
      ...(binding
        ? {
            workspaceConfirmation: { workspaceId: binding.id, rootPath: binding.rootPath, version },
          }
        : {}),
    };
  });
const accessFile = resolve(values.get('--access-file')),
  connectionFile = resolve(values.get('--connection'));
const access = existsSync(accessFile)
  ? ClientAccessFileSchema.parse(JSON.parse(readFileSync(accessFile, 'utf8')))
  : { version: 1, clients: [] };
if (access.clients.some((c) => c.id === values.get('--client')) || existsSync(connectionFile))
  throw new Error(
    'Client already exists. Preserve its token and edit its explicit grants to update access.',
  );
const token = randomBytes(32).toString('hex');
access.clients.push({
  id: values.get('--client'),
  name: values.get('--client'),
  enabled: true,
  tokenSha256: createHash('sha256').update(token).digest('hex'),
  projects,
  tools: clientToolDefinitions.map((t) => t.name),
});
ClientAccessFileSchema.parse(access);
mkdirSync(dirname(accessFile), { recursive: true });
mkdirSync(dirname(connectionFile), { recursive: true });
writeFileSync(connectionFile, JSON.stringify({ version: 1, baseUrl: url.origin, token }, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
writeFileSync(accessFile, JSON.stringify(access, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    client: values.get('--client'),
    projectIds: projects.map((p) => p.projectId),
    accessFile,
    connectionFile,
  }),
);
