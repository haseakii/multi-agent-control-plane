import { expect, it } from 'vitest';
import { updateCodexMcpProgram } from '../../../scripts/lib/codex-mcp-config.mjs';

const update = (text) =>
  updateCodexMcpProgram(text, {
    previousCommand: 'D:/old/node.exe',
    previousArgs: ['D:/old/client.js', '--connection', 'D:/same/connection.json'],
    command: 'D:/new/node.exe',
    args: ['D:/new/client.js', '--connection', 'D:/same/connection.json'],
  });
const before =
  '[mcp_servers.local_collaboration]\ncommand = "D:/old/node.exe"\nargs = ["D:/old/client.js","--connection","D:/same/connection.json"]\n[windows]\n  sandbox = "unelevated"\n';
it.each(['\n', '\r\n'])(
  'keeps the adjacent windows table on its own line with %j endings',
  (eol) => {
    const text = before.replaceAll('\n', eol),
      result = update(text);
    expect(result).toBe(text.replaceAll('D:/old/', 'D:/new/'));
    expect(result).toContain(']' + eol + '[windows]' + eol);
  },
);
it('preserves comments, blank lines, a BOM and all unrelated tables exactly', () => {
  const text =
    '\uFEFF# user settings\n[windows]\nsandbox="unelevated"\n\n' +
    before.replace('\ncommand =', '\n  command =').replace('node.exe"\n', 'node.exe" # runtime\n') +
    '\n[projects."D:/project"]\ntrust_level="trusted"';
  expect(update(text)).toBe(text.replaceAll('D:/old/', 'D:/new/'));
});
it('refuses a changed or ambiguous entry rather than reconstructing the configuration', () => {
  expect(() => update(before.replace('D:/old/client.js', 'D:/different/client.js'))).toThrow();
  expect(() => update(before + before)).toThrow();
  expect(() =>
    update(before.replace('[windows]', 'command = "D:/extra/node.exe"\n[windows]')),
  ).toThrow();
  expect(() => update(before.replace(']\n[windows]', '][windows]'))).toThrow();
});
