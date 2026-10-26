import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { AgentDefinitionSchema } from '@control-plane/core';
import type { CatalogEntry } from './agent-catalog.js';
import type { RegisteredAgentView } from './agent-control.js';
import { installedPackageEntries, installedPackageName } from './agent-installed-package.js';

export const DiscoveredEntrySchema = z.object({
  source: z.enum(['registered', 'path', 'directory', 'package']),
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
  const directories = [
    ...new Set(
      [
        ...(platform === 'win32'
          ? [
              environment.APPDATA && paths.join(environment.APPDATA, 'npm'),
              environment.LOCALAPPDATA && paths.join(environment.LOCALAPPDATA, 'pnpm'),
              environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix,
            ]
          : [environment.HOME && paths.join(environment.HOME, '.local', 'bin')]),
        ...(options.path ?? environment.PATH ?? '').split(paths.delimiter),
      ]
        .filter((value): value is string => !!value)
        .map((value) => value.trim().replace(/^"(.*)"$/, '$1'))
        .filter(
          (value) =>
            paths.isAbsolute(value) && (platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)),
        ),
    ),
  ].slice(0, 64);
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
      if (candidates.some((candidate) => normalize(candidate.runtime.command) === normalize(path)))
        continue;
      if (!isFile(path)) continue;
      candidates.push({
        source: localPaths.includes(path) ? 'directory' : 'path',
        name: entry.name,
        runtime: { type: 'acp-stdio', command: path, args: [] },
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
          ...(platform === 'win32'
            ? []
            : [paths.join(directory, '..', 'lib', 'node_modules', packageName)]),
        ]),
      ]),
    ];
    const seenScripts = new Set<string>();
    for (const root of roots) {
      for (const installed of installedPackageEntries(root, packageName)) {
        if (seenScripts.has(normalize(installed.script))) continue;
        seenScripts.add(normalize(installed.script));
        if (
          candidates.some(
            (candidate) =>
              candidate.runtime.args[0] &&
              normalize(paths.normalize(candidate.runtime.args[0])) === normalize(installed.script),
          )
        )
          continue;
        candidates.push({
          source: 'package',
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
    note: '仅检查本机 PATH、用户 npm/pnpm 常用目录和指定安装目录；未启动程序。旧成员记录会单独标注入口是否有效。包版本来自本机声明，产品建议参数需另行确认。',
  });
}
