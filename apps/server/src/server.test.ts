import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the service health payload', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'multi-agent-control-plane',
    });
  });

  it('rejects foreign browser origins and rebinding hosts, but permits local API clients', async () => {
    for (const headers of [
      { host: 'attacker.example' },
      { host: '127.0.0.1:3000', origin: 'https://attacker.example' },
      { host: '127.0.0.1:3000', origin: 'null' },
      { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
      { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:9999' },
    ]) {
      expect((await app.inject({ url: '/api/control-center', headers })).statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          url: '/api/control-center',
          headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/control-center',
          headers: { host: '127.0.0.1:3000' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
