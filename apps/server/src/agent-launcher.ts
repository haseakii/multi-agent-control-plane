import { writeFileSync } from 'node:fs';
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
    runtimeEnvironment: Environment.default({}),
  })
  .strict();

/** A package adapter fixes interpreter prefixes; user-facing ACP args remain replaceable for login. */
export function managedAgentRuntime(options: {
  directory: string;
  command: string;
  prefixArgs?: string[];
  args: string[];
  environment?: Record<string, string> | undefined;
  runtimeEnvironment?: Record<string, string> | undefined;
  nodeExecutable?: string | undefined;
}) {
  const environment = catalogEnvironment(options.environment);
  const runtimeEnvironment = catalogEnvironment(options.runtimeEnvironment);
  if (
    !Object.keys(environment).length &&
    !Object.keys(runtimeEnvironment).length &&
    !/\.(cmd|bat)$/i.test(options.command)
  )
    return {
      type: 'acp-stdio' as const,
      command: options.command,
      args: [...(options.prefixArgs ?? []), ...options.args],
    };
  const config = Config.parse({
    command: options.command,
    prefixArgs: options.prefixArgs ?? [],
    environment,
    runtimeEnvironment,
  });
  const file = join(options.directory, 'managed-agent.mjs');
  // Installation-owned launcher survives source execution and release replacement.
  // Config is validated above; generated code imports only Node built-ins.
  writeFileSync(
    file,
    `import { spawn } from 'node:child_process';\nimport { join } from 'node:path';\nconst config = ${JSON.stringify(config)};\n${launcherSource}`,
    { flag: 'wx', mode: 0o600 },
  );
  return {
    type: 'acp-stdio' as const,
    command: options.nodeExecutable ?? process.execPath,
    args: [file, ...options.args],
  };
}

// Fixed launcher body. No installed server modules or credentials are copied.
const launcherSource = String.raw`
  const environment = {
    ...process.env,
    ...(process.env.CP_TERMINAL_AUTH === '1' ? {} : config.environment),
    ...config.runtimeEnvironment,
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
          '""%CP_AGENT_BATCH%" ' + args.map((arg) => '"' + arg + '"').join(' ') + '"' ,
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
`;
