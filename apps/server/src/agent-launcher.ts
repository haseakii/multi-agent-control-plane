import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { assertNoPotentialSecrets } from '@control-plane/storage';

const Environment = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192))
  .refine((value) => Object.keys(value).length <= 32);
export function catalogEnvironment(value: Record<string, string> = {}) {
  const parsed = Environment.parse(value);
  if (
    Object.keys(parsed).some((key) =>
      /(?:^|_)(?:PASSWORD|PASSPHRASE|API_KEY|TOKEN|SECRET|CREDENTIALS)(?:_|$)/i.test(key),
    )
  )
    throw new Error('Catalog credentials require Agent-owned authentication.');
  if (
    Object.keys(parsed).some((key) =>
      /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|NODE_OPTIONS|CP_.*|CONTROL_PLANE_.*)$/i.test(key),
    )
  )
    throw new Error('Catalog environment overrides a host runtime setting.');
  assertNoPotentialSecrets(parsed);
  return parsed;
}
const Config = z
  .object({
    command: z.string().min(1).max(4096).refine(isAbsolute),
    prefixArgs: z.array(z.string().max(4096)).max(4),
    environment: Environment,
  })
  .strict();

/** A package adapter fixes interpreter prefixes; user-facing ACP args remain replaceable for login. */
export function managedAgentRuntime(options: {
  directory: string;
  command: string;
  prefixArgs?: string[];
  args: string[];
  environment?: Record<string, string> | undefined;
  nodeExecutable?: string | undefined;
}) {
  const environment = catalogEnvironment(options.environment);
  if (!Object.keys(environment).length && !/\.(cmd|bat)$/i.test(options.command))
    return {
      type: 'acp-stdio' as const,
      command: options.command,
      args: [...(options.prefixArgs ?? []), ...options.args],
    };
  const config = Config.parse({
    command: options.command,
    prefixArgs: options.prefixArgs ?? [],
    environment,
  });
  const file = join(options.directory, 'managed-agent.mjs');
  const sibling = new URL('./agent-launcher.js', import.meta.url);
  const moduleUrl = (
    existsSync(sibling) ? sibling : new URL('../dist/agent-launcher.js', import.meta.url)
  ).href;
  if (!existsSync(new URL(moduleUrl))) throw new Error('Compiled ACP launcher unavailable.');
  writeFileSync(
    file,
    `import { runManagedAgent } from ${JSON.stringify(moduleUrl)};\nrunManagedAgent(${JSON.stringify(config)});\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return {
    type: 'acp-stdio' as const,
    command: options.nodeExecutable ?? process.execPath,
    args: [file, ...options.args],
  };
}

export function runManagedAgent(raw: unknown) {
  const config = Config.parse(raw);
  const environment = {
    ...process.env,
    ...(process.env.CP_TERMINAL_AUTH === '1' ? {} : config.environment),
  };
  delete environment.CP_TERMINAL_AUTH;
  const args = [...config.prefixArgs, ...process.argv.slice(2)];
  const batch = /\.(cmd|bat)$/i.test(config.command);
  // CMD expansion characters are refused rather than interpreted. All ordinary
  // executable and Python/Node invocations bypass a shell entirely.
  if (batch && args.some((arg) => /[&|<>^()%!"\r\n]/.test(arg)))
    throw new Error('Unsupported batch argument.');
  if (batch) environment.CP_AGENT_BATCH = config.command;
  const child = spawn(
    batch ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe') : config.command,
    batch
      ? [
          '/d',
          '/s',
          '/v:off',
          '/c',
          `""%CP_AGENT_BATCH%" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
        ]
      : args,
    {
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
      ...(batch ? { windowsVerbatimArguments: true } : {}),
    },
  );
  child.once('error', () => {
    console.error('Managed ACP entry could not start.');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
