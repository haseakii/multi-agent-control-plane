import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { AgentPackageInstallError } from './agent-package-error.js';
import { prepareNativeRuntime } from './agent-native-runtime.js';
import { npmHost } from './agent-npm-lock.js';

type NativeBinding = { variable: string; binary: string; source: string };
type OwnedFile = (filename: string) => string;
const bindings: Record<string, (entry: string, owned: OwnedFile) => NativeBinding> = {
  '@agentclientprotocol/codex-acp': (entry, owned) => {
    const triples: Record<string, string> = {
      'win32-x64': 'x86_64-pc-windows-msvc',
      'win32-arm64': 'aarch64-pc-windows-msvc',
      'darwin-x64': 'x86_64-apple-darwin',
      'darwin-arm64': 'aarch64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-musl',
      'linux-arm64': 'aarch64-unknown-linux-musl',
    };
    const triple = triples[`${process.platform}-${process.arch}`];
    if (!triple) throw new AgentPackageInstallError('本机平台没有可用的 Codex 运行程序。');
    const cli = owned(createRequire(entry).resolve('@openai/codex/bin/codex.js'));
    const manifest = owned(
      createRequire(cli).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`),
    );
    const binary = owned(
      join(
        dirname(manifest),
        'vendor',
        triple,
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      ),
    );
    return { variable: 'CODEX_PATH', binary, source: dirname(dirname(binary)) };
  },
  '@agentclientprotocol/claude-agent-acp': (entry, owned) => {
    const sdk = owned(createRequire(entry).resolve('@anthropic-ai/claude-agent-sdk'));
    const host = npmHost();
    const variant = host.os === 'linux' && host.libc === 'musl' ? '-musl' : '';
    const binary = owned(
      createRequire(sdk).resolve(
        `@anthropic-ai/claude-agent-sdk-${host.os}-${host.arch}${variant}/claude${host.os === 'win32' ? '.exe' : ''}`,
      ),
    );
    return { variable: 'CLAUDE_CODE_EXECUTABLE', binary, source: dirname(binary) };
  },
};

/** Only provider-specific native layout knowledge lives here; npm recovery is fully generic. */
export async function adapterRuntimeEnvironment(
  packageName: string,
  directory: string,
  entry: string,
  signal?: AbortSignal,
) {
  const strategy = Object.hasOwn(bindings, packageName) ? bindings[packageName] : undefined;
  if (!strategy) return {};
  const root = realpathSync(directory);
  const owned: OwnedFile = (filename) => {
    const canonical = realpathSync(filename),
      path = relative(root, canonical);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw new AgentPackageInstallError('运行依赖未安装在本次目录内。');
    return canonical;
  };
  const binding = strategy(owned(entry), owned);
  if (!statSync(binding.binary).isFile())
    throw new AgentPackageInstallError('原生运行程序未安装完成。');
  const binary =
    process.platform === 'win32'
      ? join(
          await prepareNativeRuntime(root, binding.source, 'runtime', signal),
          relative(binding.source, binding.binary),
        )
      : binding.binary;
  return { [binding.variable]: binary };
}
