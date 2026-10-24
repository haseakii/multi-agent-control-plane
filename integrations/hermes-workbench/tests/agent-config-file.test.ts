import { expect, it, vi } from 'vitest';
import { readAgentConfigFile } from '../src/agent-config-file';

function file(text: string) {
  return { size: new TextEncoder().encode(text).length, text: async () => text };
}

it('previews multiple UTF-8 BOM entries while preserving valid members beside invalid ones', async () => {
  const entries = await readAgentConfigFile(
    file(
      '\uFEFF' +
        JSON.stringify({
          agent_servers: {
            开发助手: { command: 'C:/Tools/agent.exe', args: ['--stdio'] },
            审阅助手: {
              command: 'C:/Tools/node.exe',
              args: ['C:/Tools/reviewer.js'],
              environmentAllowlist: ['GEMINI_API_KEY'],
            },
            需要修正: { command: 'npx', args: ['missing'] },
          },
        }),
    ),
  );
  expect(entries.map((entry) => entry.name)).toEqual(['开发助手', '审阅助手', '需要修正']);
  expect(entries[0]?.parsed?.runtime.command).toBe('C:/Tools/agent.exe');
  expect(entries[1]?.parsed?.runtime.environmentAllowlist).toEqual(['GEMINI_API_KEY']);
  expect(entries[2]?.error).toContain('完整本机路径');
});

it('does not import credential values or role permissions from a config file', async () => {
  const entries = await readAgentConfigFile(
    file(
      JSON.stringify({
        agent_servers: {
          带登录参数: { command: 'C:/Tools/a.exe', args: ['--token', 'synthetic-value'] },
          带环境值: { command: 'C:/Tools/b.exe', env: { KEY: 'synthetic-value' } },
          带权限: { command: 'C:/Tools/c.exe', orchestration: { canBeBoss: true } },
        },
      }),
    ),
  );
  expect(entries.every((entry) => !entry.parsed && !!entry.error)).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('synthetic-value');
});

it('rejects oversized files before reading and reports malformed or non-JSON input', async () => {
  const text = vi.fn();
  await expect(readAgentConfigFile({ size: 262145, text })).rejects.toThrow('256 KB');
  expect(text).not.toHaveBeenCalled();
  await expect(readAgentConfigFile(file('{oops'))).rejects.toThrow('JSON 格式不正确');
  await expect(readAgentConfigFile(file('C:/Tools/a.exe'))).rejects.toThrow('启动命令可直接粘贴');
});

it('reports unreadable files without exposing filesystem diagnostics', async () => {
  await expect(
    readAgentConfigFile({
      size: 10,
      text: async () => {
        throw Error('private detail');
      },
    }),
  ).rejects.toThrow('已有待接入列表仍保留');
});
