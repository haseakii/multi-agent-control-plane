import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';

it('serves UI and assets under unchanged local-origin checks without exposing files or API fallbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-web-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<h1>UI fixture</h1>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("fixture")');
  writeFileSync(join(root, 'private.txt'), 'not public');
  const app = buildServer({ webRoot: web });
  try {
    expect((await app.inject('/')).headers['content-type']).toContain('text/html');
    expect((await app.inject('/assets/app.js')).headers['content-type']).toContain('javascript');
    const navigationHeaders = {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    const taskLink = '/?task=task-8781b11e-615f-4583-9960-b616b9121717';
    for (const url of ['/', taskLink]) {
      const entry = await app.inject({ url, headers: navigationHeaders });
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toBe('<h1>UI fixture</h1>');
    }
    for (const url of ['/api/control-center', '/api/control-center?task=example', '/assets/app.js'])
      expect((await app.inject({ url, headers: navigationHeaders })).statusCode).toBe(403);
    for (const headers of [
      { ...navigationHeaders, origin: 'https://foreign.example' },
      { ...navigationHeaders, host: 'attacker.example' },
      { ...navigationHeaders, 'sec-fetch-dest': 'iframe' },
      { ...navigationHeaders, 'sec-fetch-mode': 'cors' },
    ])
      expect((await app.inject({ url: taskLink, headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: taskLink, headers: navigationHeaders })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/',
          headers: { ...navigationHeaders, origin: 'https://foreign.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/',
          headers: { ...navigationHeaders, 'sec-fetch-dest': 'iframe' },
        })
      ).statusCode,
    ).toBe(403);
    for (const url of [
      '/api/missing',
      '/internal/missing',
      '/private.txt',
      '/assets/../private.txt',
      '/assets/%2e%2e/%2e%2e/private.txt',
      '/assets/missing.js',
    ])
      expect((await app.inject(url)).statusCode).toBe(404);
    for (const headers of [
      { host: 'attacker.example' },
      { host: '127.0.0.1:3000', origin: 'http://attacker.example' },
      { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
    ])
      for (const url of ['/', '/assets/app.js', '/api/control-center'])
        expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: '/',
          headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
