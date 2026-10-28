import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter, join } from 'node:path';
import { z } from 'zod';

export const DetectedAgentCLISchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  description: z.string(),
  installed: z.boolean(),
  resolvedPath: z.string().optional(),
  registered: z.boolean(),
});
export type DetectedAgentCLI = z.infer<typeof DetectedAgentCLISchema>;

export const ProxyDetectionResultSchema = z.object({
  detected: z.boolean(),
  port: z.number().int().optional(),
  proxyUrl: z.string().optional(),
  clientHint: z.string().optional(),
});
export type ProxyDetectionResult = z.infer<typeof ProxyDetectionResultSchema>;

export interface KnownCLIDefinition {
  id: string;
  name: string;
  binaryNames: string[];
  recommendedArgs: string[];
  description: string;
}

export const KNOWN_CLIS: KnownCLIDefinition[] = [
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    binaryNames: ['agy', 'agy.cmd', 'agy.exe', 'agy.bat'],
    recommendedArgs: [],
    description: 'Google Antigravity 官方 CLI，原生支持 ACP 协议与多模型协作。',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    binaryNames: ['codebuddy', 'codebuddy.cmd', 'codebuddy.exe', 'codebuddy.bat'],
    recommendedArgs: [],
    description: 'CodeBuddy 本地编码助手，提供 ACP 代码审查与生成能力。',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    binaryNames: ['codex', 'codex.cmd', 'codex.exe', 'codex.bat'],
    recommendedArgs: [],
    description: 'OpenAI Codex 命令行工具，支持代码补全与任务执行。',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    binaryNames: ['ollama', 'ollama.exe'],
    recommendedArgs: ['serve'],
    description: '本地开源大模型运行工具，支持 Llama 3、DeepSeek、Qwen 等模型。',
  },
];

export function findExecutableInPath(
  binaryNames: string[],
  customPath?: string,
  extraDirs: string[] = [],
): string | undefined {
  const envPath = customPath ?? process.env.PATH ?? '';
  const searchDirs = [...envPath.split(delimiter), ...extraDirs].filter(Boolean);

  for (const dir of searchDirs) {
    for (const name of binaryNames) {
      const fullPath = join(dir, name);
      try {
        if (existsSync(fullPath)) {
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            return fullPath;
          }
        }
      } catch {
        // Skip unreadable paths
      }
    }
  }
  return undefined;
}

export function detectInstalledAgentCLIs(
  registeredAgentCommands: string[] = [],
  customPath?: string,
): DetectedAgentCLI[] {
  const extraDirs: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    if (appData) {
      extraDirs.push(join(appData, 'npm'));
    }
    if (localAppData) {
      extraDirs.push(join(localAppData, 'Programs'));
    }
    if (userProfile) {
      extraDirs.push(join(userProfile, '.gemini', 'antigravity', 'bin'));
      extraDirs.push(join(userProfile, '.cargo', 'bin'));
    }
  }

  const normalizedRegistered = new Set(registeredAgentCommands.map((c) => c.toLowerCase().trim()));

  return KNOWN_CLIS.map((cli) => {
    const resolvedPath = findExecutableInPath(cli.binaryNames, customPath, extraDirs);
    const installed = !!resolvedPath;
    const baseCmd = cli.binaryNames[0]!;

    const isRegistered =
      normalizedRegistered.has(baseCmd.toLowerCase()) ||
      (resolvedPath ? normalizedRegistered.has(resolvedPath.toLowerCase()) : false) ||
      registeredAgentCommands.some((c) =>
        cli.binaryNames.some((b) => c.toLowerCase().endsWith(b.toLowerCase())),
      );

    return {
      id: cli.id,
      name: cli.name,
      command: resolvedPath ?? baseCmd,
      args: cli.recommendedArgs,
      description: cli.description,
      installed,
      resolvedPath,
      registered: isRegistered,
    };
  });
}

const COMMON_PROXY_PORTS: { port: number; clientHint: string }[] = [
  { port: 7890, clientHint: 'Clash / Clash Verge / Mihomo' },
  { port: 10809, clientHint: 'v2rayN (HTTP)' },
  { port: 20811, clientHint: 'Sing-box' },
  { port: 10808, clientHint: 'v2rayN (SOCKS/HTTP)' },
  { port: 7891, clientHint: 'Clash (Mixed)' },
];

export async function probeTcpPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 250,
): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const socket = createConnection({ port, host });

    const finish = (result: boolean) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function detectLocalProxy(): Promise<ProxyDetectionResult> {
  for (const { port, clientHint } of COMMON_PROXY_PORTS) {
    try {
      const active = await probeTcpPort(port);
      if (active) {
        return {
          detected: true,
          port,
          proxyUrl: `http://127.0.0.1:${port}`,
          clientHint,
        };
      }
    } catch {
      // Non-fatal, try next port
    }
  }

  return { detected: false };
}
