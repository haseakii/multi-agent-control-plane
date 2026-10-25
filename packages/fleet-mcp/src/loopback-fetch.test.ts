import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { loopbackFetch } from './loopback-fetch.js';
it('keeps bridge traffic direct in a child started with proxy environment enabled and refuses redirects', async () => {
  const servers: Server[] = [];
  let proxyHits = 0,
    localHits = 0;
  const start = async (server: Server) => {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  };
  try {
    const proxy = await start(
      createServer((_request, response) => {
        proxyHits++;
        response.writeHead(502);
        response.end();
      }),
    );
    const local = await start(
      createServer((request, response) => {
        localHits++;
        if (request.url === '/redirect') {
          response.writeHead(302, { location: 'https://not-contacted.invalid' });
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end('{"local":true}');
      }),
    );
    const code =
      "const {loopbackFetch}=await import(process.argv[2]);const response=await loopbackFetch(process.argv[1],{method:'POST',headers:{authorization:'Bearer synthetic-local-only'},body:'{}',signal:AbortSignal.timeout(3000)});if(!(await response.json()).local)throw Error('Wrong route');console.log('direct');";
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        code,
        local,
        new URL('../dist/loopback-fetch.js', import.meta.url).href,
      ],
      {
        windowsHide: true,
        timeout: 7000,
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: '',
          no_proxy: '',
        },
      },
    );
    expect(result.stdout.trim()).toBe('direct');
    expect(localHits).toBe(1);
    expect(proxyHits).toBe(0);
    await expect(loopbackFetch(local + '/redirect')).rejects.toThrow('redirect');
    await expect(loopbackFetch('https://not-contacted.invalid')).rejects.toThrow('local');
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}, 10000);
