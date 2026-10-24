import { createConnection, createServer } from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const Owner = z.object({ pid: z.number().int().positive(), token: z.uuid() });
const Control = Owner.extend({ port: z.number().int().min(1).max(65535) });

/** Private local lifecycle channel. No HTTP endpoint or task tool can stop the engine. */
export async function createInstanceControl(dataDir: string, stop: () => void) {
  const owner = Owner.parse(JSON.parse(readFileSync(join(dataDir, 'instance.lock'), 'utf8')));
  const server = createServer((socket) => {
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      let authorized = false;
      try {
        authorized =
          z
            .object({ token: z.uuid(), action: z.literal('stop') })
            .strict()
            .parse(JSON.parse(input.trim())).token === owner.token;
      } catch {
        /* reject */
      }
      socket.end(authorized ? 'accepted\n' : 'denied\n');
      if (authorized) stop();
    });
  });
  await new Promise<void>((ok, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Lifecycle address unavailable.');
  try {
    writeFileSync(
      join(dataDir, 'instance-control.json'),
      JSON.stringify({ ...owner, port: address.port }),
      { mode: 0o600 },
    );
  } catch (error) {
    server.close();
    throw error;
  }
  return () => new Promise<void>((ok, no) => server.close((error) => (error ? no(error) : ok())));
}

export async function stopInstance(dataDir: string): Promise<void> {
  const lock = join(dataDir, 'instance.lock');
  if (!existsSync(lock)) return;
  const owner = Owner.parse(JSON.parse(readFileSync(lock, 'utf8')));
  const control = Control.parse(
    JSON.parse(readFileSync(join(dataDir, 'instance-control.json'), 'utf8')),
  );
  if (control.pid !== owner.pid || control.token !== owner.token)
    throw new Error('Instance owner changed; no stop sent.');
  await new Promise<void>((ok, no) => {
    const socket = createConnection({ host: '127.0.0.1', port: control.port });
    let reply = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Stop request timed out.')));
    socket.once('error', no);
    socket.once('connect', () =>
      socket.write(JSON.stringify({ token: owner.token, action: 'stop' }) + '\n'),
    );
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      if (reply.length > 1024) socket.destroy(new Error('Invalid stop response.'));
    });
    socket.once('end', () => (reply === 'accepted\n' ? ok() : no(new Error('Stop denied.'))));
  });
  for (let i = 0; i < 120; i++) {
    if (!existsSync(lock)) return;
    const current = Owner.parse(JSON.parse(readFileSync(lock, 'utf8')));
    if (current.token !== owner.token) return;
    await delay(250);
  }
  throw new Error('Engine is still draining. No process was killed and no lock was deleted.');
}
