import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const Invocation = z
  .object({
    command: z.string().min(1).max(4096).refine(isAbsolute),
    args: z.array(z.string().max(4096)).max(68),
    cwd: z.string().refine(isAbsolute),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)),
  })
  .strict();
try {
  const config = Invocation.parse(JSON.parse(process.env.CP_AUTH_INVOCATION ?? ''));
  delete process.env.CP_AUTH_INVOCATION;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, config.environment);
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  child.once('error', () => {
    console.error('登录程序未能启动，请返回工作台重试。');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} catch {
  console.error('登录入口无效，请返回工作台重新读取成员登录方式。');
  process.exitCode = 1;
}
