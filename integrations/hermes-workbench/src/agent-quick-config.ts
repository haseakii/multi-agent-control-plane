import { z } from 'zod';

export function parseAgentCommands(input: string) {
  const text = input.trim();
  if (text.length > 262_144) throw new Error('配置过大，请每次导入不超过 256 KB。');
  if (text.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('JSON 格式不正确，请检查引号、逗号和括号。');
    }
    if (json.agent_servers !== undefined) {
      if (
        !json.agent_servers ||
        Array.isArray(json.agent_servers) ||
        typeof json.agent_servers !== 'object'
      )
        throw new Error('agent_servers 应为以成员名称为键的对象。');
      const entries = Object.entries(json.agent_servers);
      if (!entries.length || entries.length > 20) throw new Error('每次可接入 1 至 20 位成员。');
      return entries.map(([name, runtime]) => {
        try {
          return {
            name,
            parsed: parseAgentCommand(JSON.stringify({ agent_servers: { [name]: runtime } })),
          };
        } catch (error) {
          return { name, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  }
  const parsed = parseAgentCommand(text);
  return [{ name: parsed.suggestedName, parsed }];
}

/** Compare execution configuration, not display labels or vendor names. */
export function sameAgentRuntime(
  a: ReturnType<typeof parseAgentCommand>['runtime'],
  b: ReturnType<typeof parseAgentCommand>['runtime'],
) {
  return (
    a.command === b.command &&
    a.cwd === b.cwd &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify([...(a.environmentAllowlist ?? [])].sort()) ===
      JSON.stringify([...(b.environmentAllowlist ?? [])].sort())
  );
}

/** Keep existing row identity and progress when adding more products to a batch. */
export function appendAgentCandidates<
  T extends {
    runtime?: ReturnType<typeof parseAgentCommand>['runtime'];
    name?: string;
    error?: string;
  },
>(current: T[], additions: T[]) {
  const result = [...current];
  for (const entry of additions) {
    if (
      result.some((row) =>
        entry.runtime
          ? row.runtime && sameAgentRuntime(row.runtime, entry.runtime)
          : !row.runtime &&
            entry.name !== undefined &&
            !!entry.error &&
            row.name === entry.name &&
            row.error === entry.error,
      )
    )
      continue;
    result.push(entry);
  }
  if (result.length > 20) throw new Error('每批最多接入 20 位成员，请先完成当前批次。');
  return result;
}

const Runtime = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    environmentAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  })
  .strict();

/** Tokenize an argv command, never a shell program. Backslashes in Windows paths stay literal. */
export function parseAgentCommand(input: string) {
  const text = input.trim();
  if (!text) throw new Error('请粘贴已安装的 ACP 启动命令或 JSON 配置。');
  let raw: unknown;
  let suggestedName = '';
  if (text.startsWith('{')) {
    const json = JSON.parse(text);
    if (json.agent_servers) {
      const entries = Object.entries(json.agent_servers);
      if (entries.length !== 1)
        throw new Error('每次接入一位协作者，请只保留一个 agent_servers 条目。');
      [suggestedName, raw] = entries[0]!;
    } else raw = json.runtime ?? json;
    if (raw && typeof raw === 'object') {
      const { type, ...runtime } = raw as Record<string, unknown>;
      if (type !== undefined && type !== 'acp-stdio' && type !== 'stdio')
        throw new Error('这里只接入本机 stdio ACP 程序。');
      raw = runtime;
    }
  } else {
    const tokens: string[] = [];
    let token = '',
      quote = '',
      started = false;
    for (const character of text) {
      if (quote) {
        if (character === quote) quote = '';
        else token += character;
      } else if (character === '"' || character === "'") {
        quote = character;
        started = true;
      } else if (/\s/.test(character)) {
        if (started) {
          tokens.push(token);
          token = '';
          started = false;
        }
      } else {
        if (/[|&;<>`]/.test(character))
          throw new Error('请粘贴单个程序的启动命令，不要包含 shell 管道或命令串联。');
        token += character;
        started = true;
      }
    }
    if (quote) throw new Error('启动命令的引号未闭合。');
    if (started) tokens.push(token);
    raw = { command: tokens[0], args: tokens.slice(1) };
  }
  const parsed = Runtime.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      '配置只接受 command、args、cwd 和 environmentAllowlist（变量名列表）；不要粘贴密码或环境变量值。',
    );
  const runtime = parsed.data;
  if (!/^(?:[a-z]:[\\/]|\/)/i.test(runtime.command))
    throw new Error(
      '启动程序请使用完整本机路径；例如 "C:\\Tools\\agent.exe" --stdio。不会自动安装或下载适配器。',
    );
  if (
    /[/\\](?:cmd|powershell|pwsh|bash|sh|npx|npm|pnpm|uvx)(?:\.exe)?$/i.test(runtime.command) ||
    /\.(?:cmd|bat|ps1)$/i.test(runtime.command)
  )
    throw new Error(
      '请使用已安装 ACP 程序的原生入口；Node 适配器可填写 node.exe 和已安装脚本路径。',
    );
  suggestedName ||=
    runtime.command
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, '') ?? '本机协作者';
  return { runtime: { type: 'acp-stdio' as const, ...runtime }, suggestedName };
}
