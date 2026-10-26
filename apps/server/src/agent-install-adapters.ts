import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { linkSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { AgentPackageInstallError } from './agent-package-error.js';

const adapters = {
  'codex-acp': '@agentclientprotocol/codex-acp',
  'codebuddy-code': '@tencent-ai/codebuddy-code',
  'claude-acp': '@agentclientprotocol/claude-agent-acp',
} as const;

/** Reviewed npm integrations install native optional packages from their verified lockfile. */
export function reviewedNpmAdapter(entryId: string, source: string) {
  const name = adapters[entryId as keyof typeof adapters];
  return name && source.startsWith(name + '@') ? entryId : undefined;
}

/** Interpreter bindings belong to this installation and also apply during terminal login. */
export function adapterRuntimeEnvironment(
  adapter: string | undefined,
  directory: string,
  entry: string,
) {
  if (adapter !== 'codex-acp') return {};
  const root = realpathSync(directory);
  const local = (filename: string) => {
    const canonical = realpathSync(filename),
      rel = relative(root, canonical);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new AgentPackageInstallError('Codex 运行依赖未安装在本次目录内。');
    return canonical;
  };
  const cli = local(createRequire(entry).resolve('@openai/codex/bin/codex.js'));
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const manifest = local(
    createRequire(cli).resolve(`@openai/codex-${platform}-${process.arch}/package.json`),
  );
  const triples: Record<string, string> = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
  };
  const triple = triples[`${platform}-${process.arch}`];
  if (!triple) throw new AgentPackageInstallError('本机平台没有可用的 Codex 运行程序。');
  const binary = local(
    join(
      manifest,
      '..',
      'vendor',
      triple,
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    ),
  );
  if (!statSync(binary).isFile()) throw new AgentPackageInstallError('Codex 运行程序未安装完成。');
  if (process.platform === 'win32') {
    // The adapter uses cross-spawn, whose executable lookup rejects long Windows paths.
    // Preserve native helper/resource layout as well as the main executable.
    const runtime = join(root, 'runtime');
    const linkTree = (source: string, target: string) => {
      mkdirSync(target);
      for (const item of readdirSync(source, { withFileTypes: true })) {
        const from = local(join(source, item.name)),
          to = join(target, item.name);
        if (item.isSymbolicLink())
          throw new AgentPackageInstallError('Codex 运行目录包含不支持的链接。');
        if (item.isDirectory()) linkTree(from, to);
        else if (item.isFile()) linkSync(from, to);
        else throw new AgentPackageInstallError('Codex 运行目录包含不支持的文件。');
      }
    };
    linkTree(dirname(dirname(binary)), runtime);
    const launcher = join(runtime, 'bin/codex.exe');
    return { CODEX_PATH: launcher };
  }
  return { CODEX_PATH: binary };
}
