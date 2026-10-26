import fs from 'node:fs';
export function createPromptBudget(filename, limit) {
  if (!fs.existsSync(filename))
    fs.writeFileSync(filename, JSON.stringify({ limit, used: 0, turns: [] }, null, 2), {
      flag: 'wx',
    });
  function read() {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      value.limit !== limit ||
      !Number.isInteger(value.used) ||
      value.used < 0 ||
      (limit !== null && value.used > limit) ||
      value.turns.length !== value.used
    )
      throw Error('Invalid prompt budget ledger');
    return value;
  }
  read();
  return {
    read,
    wrap(writable, agentId) {
      const writer = writable.getWriter();
      let buffer = '';
      const decoder = new TextDecoder();
      return new WritableStream({
        async write(chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 2 * 1024 * 1024) throw Error('ACP request frame too large');
          for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.method === 'session/prompt') {
              const ledger = read();
              if (limit !== null && ledger.used >= limit)
                throw Error('Authorized ACP prompt budget exhausted');
              ledger.used++;
              ledger.turns.push({
                ordinal: ledger.used,
                agentId,
                sessionId: message.params?.sessionId,
                at: new Date().toISOString(),
              });
              fs.writeFileSync(filename, JSON.stringify(ledger, null, 2));
              console.log(JSON.stringify({ promptTurn: ledger.used, limit, agentId }));
            }
            await writer.write(new TextEncoder().encode(line + '\n'));
          }
        },
        close() {
          return writer.close();
        },
        abort(reason) {
          return writer.abort(reason);
        },
      });
    },
  };
}
