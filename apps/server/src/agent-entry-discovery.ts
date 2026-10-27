import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { AgentDefinitionSchema, type AgentInstallation } from '@control-plane/core';
import type { CatalogEntry } from './agent-catalog.js';
import type { RegisteredAgentView } from './agent-control.js';
import { installedPackageEntries, installedPackageName } from './agent-installed-package.js';

export const DiscoveredEntrySchema = z.object({
  source: z.enum(['registered', 'path', 'directory', 'package', 'managed']),
  installationId: z.string().uuid().optional(),
  agentId: z.string().optional(),
  association: z.enum(['linked', 'possible']).optional(),
  available: z.boolean().optional(),
  name: z.string(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  runtime: AgentDefinitionSchema.shape.runtime,
});
export const EntryDiscoverySchema = z.object({
  candidates: z.array(DiscoveredEntrySchema),
  searchedDirectories: z.number().int().nonnegative(),
  note: z.string(),
});

export const DiscoverEntryInputSchema = z
  .object({
    entryId: z.string().min(1).max(128),
    directory: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => {
        const paths = process.platform === 'win32' ? win32 : posix;
        return (
          paths.isAbsolute(value) &&
          !/[\x00-\x1f]/.test(value) &&
          (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))
        );
      }, '请填写本机已有安装目录的完整路径。')
      .optional(),
  })
  .strict();

/** Bounded metadata lookup, never execute registry commands or traverse the user's home. */
export function discoverAgentEntries(
  entry: CatalogEntry,
  platformKey: string,
  agents: RegisteredAgentView[],
  options: {
    platform?: NodeJS.Platform;
    path?: string;
    isFile?: (path: string) => boolean;
    directory?: string;
    nodeExecutable?: string;
    environment?: NodeJS.ProcessEnv;
    installedPackages?: AgentInstallation[];
  } = {},
) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const environment = options.environment ?? process.env;
  const command = Object.entries(entry.distribution.binary ?? {}).find(
    ([key]) => key === platformKey,
  )?.[1]?.cmd;
  const relativeCommand = command?.replaceAll('\\', '/').replace(/^\.\//, '');
  const filename =
    relativeCommand &&
    relativeCommand
      .split('/')
      .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))
      ? paths.basename(relativeCommand)
      : undefined;
  const usableName =
    filename &&
    !['.', '..'].includes(filename) &&
    !/^(node|cmd|powershell|pwsh|bash|sh|npx|npm|pnpm|uvx)(\.[a-z]+)?$/i.test(filename) &&
    !/\.(cmd|bat|ps1)$/i.test(filename)
      ? filename
      : undefined;
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  const pathKey = (value: string) =>
    platform === 'win32' ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  const runtimeKey = (runtime: z.infer<typeof AgentDefinitionSchema>['runtime']) =>
    JSON.stringify([
      pathKey(runtime.command),
      runtime.args.map((arg) => (paths.isAbsolute(arg) ? pathKey(arg) : arg)),
      runtime.cwd,
    ]);
  const candidates: z.infer<typeof DiscoveredEntrySchema>[] = agents
    .filter(
      (agent) =>
        (agent.registrationSource?.status === 'linked' &&
          agent.registrationSource.record?.entryId === entry.id) ||
        normalize(agent.definition.name) === normalize(entry.name) ||
        (usableName &&
          normalize(paths.basename(agent.definition.runtime.command)) === normalize(usableName)),
    )
    .map((agent) => ({
      source: 'registered',
      agentId: agent.definition.id,
      association:
        agent.registrationSource?.status === 'linked' &&
        agent.registrationSource.record?.entryId === entry.id
          ? 'linked'
          : 'possible',
      name: agent.definition.name,
      available: agent.localEntry?.offlineChecksPassed,
      runtime: agent.definition.runtime,
    }));
  for (const row of options.installedPackages ?? []) {
    if (row.entryId !== entry.id || !row.package) continue;
    if (
      candidates.some(
        (candidate) =>
          runtimeKey(candidate.runtime) === runtimeKey(row.package!.runtime) &&
          candidate.available !== false,
      )
    )
      continue;
    candidates.push({
      source: 'managed',
      installationId: row.id,
      available: true,
      name: row.package.source.entryName,
      packageVersion: row.version,
      runtime: row.package.runtime,
    });
  }
  const directories = [
    ...new Set(
      [
        ...(platform === 'win32'
          ? [
              environment.APPDATA && paths.join(environment.APPDATA, 'npm'),
              environment.LOCALAPPDATA && paths.join(environment.LOCALAPPDATA, 'pnpm'),
              environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix,
              environment.PNPM_HOME,
              environment.USERPROFILE && paths.join(environment.USERPROFILE, '.local', 'bin'),
              environment.USERPROFILE && paths.join(environment.USERPROFILE, '.cargo', 'bin'),
            ]
          : [
              environment.HOME && paths.join(environment.HOME, '.local', 'bin'),
              environment.NPM_CONFIG_PREFIX && paths.join(environment.NPM_CONFIG_PREFIX, 'bin'),
              environment.PNPM_HOME,
            ]),
        paths.dirname(options.nodeExecutable ?? process.execPath),
        ...(options.path ?? environment.PATH ?? '').split(paths.delimiter),
      ]
        .filter((value): value is string => !!value)
        .map((value) => value.trim().replace(/^"(.*)"$/, '$1'))
        .filter(
          (value) =>
            paths.isAbsolute(value) && (platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)),
        ),
    ),
  ]
    .filter(
      (value, index, all) => all.findIndex((other) => pathKey(other) === pathKey(value)) === index,
    )
    .slice(0, 64);
  const isFile =
    options.isFile ??
    ((path: string) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  const localDirectory =
    options.directory &&
    paths.isAbsolute(options.directory) &&
    (platform !== 'win32' || /^[a-z]:[\\/]/i.test(options.directory))
      ? paths.normalize(options.directory)
      : undefined;
  if (usableName) {
    const localPaths = localDirectory
      ? [
          paths.join(localDirectory, relativeCommand!),
          paths.join(localDirectory, usableName),
          paths.join(localDirectory, 'bin', usableName),
        ]
      : [];
    for (const path of new Set([
      ...localPaths,
      ...directories.map((directory) => paths.join(directory, usableName)),
    ])) {
      if (
        candidates.some(
          (candidate) =>
            pathKey(candidate.runtime.command) === pathKey(path) && candidate.available !== false,
        )
      )
        continue;
      if (!isFile(path)) continue;
      candidates.push({
        source: localPaths.includes(path) ? 'directory' : 'path',
        name: entry.name,
        runtime: { type: 'acp-stdio', command: path, args: [] },
        available: true,
      });
    }
  }
  const packageName = installedPackageName(entry.distribution.npx?.package);
  const node = options.nodeExecutable ?? process.execPath;
  if (
    packageName &&
    paths.isAbsolute(node) &&
    /^node(?:\.exe)?$/i.test(paths.basename(node)) &&
    isFile(node)
  ) {
    const roots = [
      ...new Set([
        ...(localDirectory
          ? [
              localDirectory,
              paths.join(localDirectory, packageName),
              paths.join(localDirectory, 'node_modules', packageName),
              paths.join(localDirectory, 'lib', 'node_modules', packageName),
            ]
          : []),
        ...directories.flatMap((directory) => [
          paths.join(directory, 'node_modules', packageName),
          paths.join(directory, 'global', '5', 'node_modules', packageName),
          ...(platform === 'win32'
            ? []
            : [paths.join(directory, '..', 'lib', 'node_modules', packageName)]),
        ]),
      ]),
    ];
    const seenScripts = new Set<string>();
    for (const root of roots) {
      for (const installed of installedPackageEntries(root, packageName)) {
        if (seenScripts.has(pathKey(installed.script))) continue;
        seenScripts.add(pathKey(installed.script));
        if (
          candidates.some(
            (candidate) =>
              candidate.runtime.args[0] &&
              pathKey(candidate.runtime.args[0]) === pathKey(installed.script) &&
              candidate.available !== false,
          )
        )
          continue;
        candidates.push({
          source: 'package',
          available: true,
          name: entry.name,
          packageName: installed.packageName,
          packageVersion: installed.packageVersion,
          runtime: { type: 'acp-stdio', command: node, args: [installed.script] },
        });
      }
    }
  }
  return EntryDiscoverySchema.parse({
    candidates,
    searchedDirectories:
      usableName || packageName ? directories.length + (localDirectory ? 1 : 0) : 0,
    note: '已检查工作台安装记录、本机 PATH、Node/npm/pnpm 常用目录和指定目录；未启动程序或下载软件。失效成员单独标注；找到程序不代表已登录或 ACP 连接成功。',
  });
}
