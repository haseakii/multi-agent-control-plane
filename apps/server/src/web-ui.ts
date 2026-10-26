import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Only built index/assets are public. API and unknown paths remain JSON 404. */
export function registerWebUi(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const serve = async (name: string, reply: FastifyReply, immutable = false) => {
    try {
      const canonicalRoot = await realpath(root);
      const file = await realpath(resolve(root, name));
      const local = relative(canonicalRoot, file);
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
        return reply.code(404).send({ error: 'Not found.' });
      const content = await readFile(file);
      return reply
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .type(types[extname(file)] ?? 'application/octet-stream')
        .send(content);
    } catch {
      return reply.code(404).send({ error: 'Not found.' });
    }
  };
  app.get('/', async (_request, reply) => serve('index.html', reply));
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const name = request.params['*'];
    if (!name || name.split(/[\\/]/).includes('..') || name.includes('\0'))
      return reply.code(404).send({ error: 'Not found.' });
    return serve(`assets/${name}`, reply, true);
  });
}
