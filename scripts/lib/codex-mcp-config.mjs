/** Replace only two complete single-line JSON-compatible TOML values; preserve all line endings. */
export function updateCodexMcpProgram(text, { previousCommand, previousArgs, command, args }) {
  if (typeof text !== 'string' || /\r(?!\n)/.test(text))
    throw new Error('Unsupported configuration text.');
  const valid = (value) => typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value);
  if (
    !valid(previousCommand) ||
    !valid(command) ||
    !command ||
    ![previousArgs, args].every(
      (value) => Array.isArray(value) && value.length <= 128 && value.every(valid),
    )
  )
    throw new Error('Invalid MCP program update.');
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|$)/g).filter(Boolean);
  const body = (line) => line.replace(/\r?\n$/, '');
  const target = lines.flatMap((line, index) =>
    /^[\t ]*\[mcp_servers\.local_collaboration\][\t ]*(?:#.*)?$/.test(
      body(line).replace(/^\uFEFF/, ''),
    )
      ? [index]
      : [],
  );
  if (target.length !== 1) throw new Error('Expected one existing local_collaboration table.');
  const start = target[0];
  let end = start + 1;
  while (end < lines.length && !/^[\t ]*\[/.test(body(lines[end]))) end++;
  for (const [key, previous, next] of [
    ['command', previousCommand, command],
    ['args', previousArgs, args],
  ]) {
    const matcher =
      key === 'command'
        ? /^([\t ]*command[\t ]*=[\t ]*)("(?:[^"\\]|\\.)*")([\t ]*(?:#.*)?)$/
        : /^([\t ]*args[\t ]*=[\t ]*)(\[[^\r\n]*\])([\t ]*(?:#.*)?)$/;
    const matches = [];
    for (let index = start + 1; index < end; index++) {
      const match = body(lines[index]).match(matcher);
      if (match) matches.push({ index, match });
    }
    if (matches.length !== 1) throw new Error('Expected one supported ' + key + ' line.');
    const { index, match } = matches[0];
    if (JSON.stringify(JSON.parse(match[2])) !== JSON.stringify(previous))
      throw new Error('MCP entry changed; preserve the current configuration.');
    const ending = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '';
    lines[index] = match[1] + JSON.stringify(next) + match[3] + ending;
  }
  return lines.join('');
}
