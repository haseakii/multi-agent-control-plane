import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { TaskControlError } from './task-control.js';

/** Discover an existing native CLI only. Never invoke a shell or download a CLI. */
export function codexCliPath(environment: NodeJS.ProcessEnv = process.env) {
  const paths = [
    dirname(process.execPath),
    ...(environment.PATH ?? '').split(delimiter),
    environment.APPDATA ? join(environment.APPDATA, 'npm') : '',
  ];
  return paths
    .filter(isAbsolute)
    .map((p) => join(p, 'node_modules/@openai/codex/bin/codex.js'))
    .find(existsSync);
}
export async function installCodexClient(
  name: string,
  server: { command: string; args: string[] },
  options: { cli?: string; home?: string; execute?: typeof execFile } = {},
) {
  if (!/^collaboration_[a-f0-9]{8}$/.test(name) || !isAbsolute(server.command))
    throw new Error('Invalid generated client.');
  const cli = options.cli ?? codexCliPath();
  if (!cli)
    throw new TaskControlError(
      409,
      '未发现已安装的 Codex CLI。请使用复制配置，或安装客户端后重试。',
    );
  // The running server may use an ACP member's CODEX_HOME. Never write into it.
  const home = options.home ?? join(process.env.USERPROFILE ?? homedir(), '.codex');
  const run = promisify(options.execute ?? execFile);
  const invocation = {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 512_000,
    env: { ...process.env, CODEX_HOME: home },
  };
  let existing: unknown;
  try {
    existing = JSON.parse(
      (await run(process.execPath, [cli, 'mcp', 'get', name, '--json'], invocation))
        .stdout as string,
    );
  } catch {
    /* native add will validate TOML */
  }
  if (existing) {
    const transport = (existing as { transport?: { command?: string; args?: string[] } }).transport;
    if (
      transport?.command === server.command &&
      JSON.stringify(transport.args) === JSON.stringify(server.args)
    )
      return;
    throw new TaskControlError(409, '客户端中已有同名配置，请保留原项并重新生成一个接入。');
  }
  const configFile = join(home, 'config.toml');
  if (existsSync(configFile)) {
    const backup = join(home, 'collaboration-backups');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, Date.now() + '-config.toml'), readFileSync(configFile), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  try {
    await run(
      process.execPath,
      [cli, 'mcp', 'add', name, '--', server.command, ...server.args],
      invocation,
    );
    const receipt = JSON.parse(
      (await run(process.execPath, [cli, 'mcp', 'get', name, '--json'], invocation))
        .stdout as string,
    );
    if (
      receipt.transport?.command !== server.command ||
      JSON.stringify(receipt.transport.args) !== JSON.stringify(server.args)
    )
      throw new Error('Configuration receipt mismatch.');
  } catch {
    throw new TaskControlError(
      409,
      'Codex 尚未确认安装成功。请刷新接入状态并重试；原配置副本已保留在 collaboration-backups。',
    );
  }
}
