import { expect, it } from 'vitest';
import { parseAgentCommand, parseAgentCommands, sameAgentRuntime } from '../src/agent-quick-config';

it('previews multiple products independently and does not accept secret environment values', () => {
  const entries = parseAgentCommands(
    JSON.stringify({
      agent_servers: {
        developer: { command: 'C:/Tools/developer.exe', args: ['--stdio'] },
        reviewer: { command: 'C:/Tools/node.exe', args: ['C:/Tools/review.js'] },
        invalid: { command: 'C:/Tools/invalid.exe', env: { TOKEN: 'do-not-repeat' } },
      },
    }),
  );
  expect(entries.map((item) => item.name)).toEqual(['developer', 'reviewer', 'invalid']);
  expect(entries.slice(0, 2).every((item) => item.parsed)).toBe(true);
  expect(entries[2]?.error).toContain('不要粘贴密码');
  expect(JSON.stringify(entries)).not.toContain('do-not-repeat');
});
it('detects identical launch configuration while keeping different arguments distinct', () => {
  const a = parseAgentCommand(
    '{"command":"C:/agent.exe","environmentAllowlist":["HOME","PATH"]}',
  ).runtime;
  expect(sameAgentRuntime(a, { ...a, environmentAllowlist: ['PATH', 'HOME'] })).toBe(true);
  expect(sameAgentRuntime(a, { ...a, args: ['--another-profile'] })).toBe(false);
  expect(sameAgentRuntime(a, { ...a, cwd: 'D:/other' })).toBe(false);
});
it('gives actionable errors for invalid import documents', () => {
  expect(() => parseAgentCommands('{broken')).toThrow('JSON 格式');
  expect(() => parseAgentCommands('{"agent_servers":[]}')).toThrow('应为');
  expect(() => parseAgentCommands('{"agent_servers":{}}')).toThrow('1 至 20');
});

it('imports a quoted Windows launch command without losing paths or argument boundaries', () => {
  expect(
    parseAgentCommand('"C:\\Program Files\\node.exe" "D:\\My Agent\\index.js" --stdio ""').runtime,
  ).toEqual({
    type: 'acp-stdio',
    command: 'C:\\Program Files\\node.exe',
    args: ['D:\\My Agent\\index.js', '--stdio', ''],
  });
});
it('imports runtime and single agent_servers JSON, retaining only explicit runtime configuration', () => {
  expect(
    parseAgentCommand(
      JSON.stringify({
        agent_servers: {
          reviewer: { command: 'C:/agent.exe', args: [], environmentAllowlist: ['APPDATA'] },
        },
      }),
    ),
  ).toEqual({
    suggestedName: 'reviewer',
    runtime: {
      type: 'acp-stdio',
      command: 'C:/agent.exe',
      args: [],
      environmentAllowlist: ['APPDATA'],
    },
  });
  expect(
    parseAgentCommand('{"runtime":{"type":"acp-stdio","command":"/bin/agent"}}').runtime.args,
  ).toEqual([]);
});
it('rejects secret-value configuration, ambiguous multiple agents and shell/install commands', () => {
  for (const input of [
    '{"command":"C:/agent.exe","env":{"TOKEN":"value"}}',
    '{"agent_servers":{"a":{},"b":{}}}',
    'npx agent',
    'C:/Windows/cmd.exe /c something',
    'C:/agent.exe | another',
    '"C:/agent.exe',
  ])
    expect(() => parseAgentCommand(input)).toThrow();
});
