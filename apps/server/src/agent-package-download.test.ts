import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadPackageFile } from './agent-package-download.js';

const roots: string[] = [];
function file() {
  const root = mkdtempSync(join(tmpdir(), 'acp-download-'));
  roots.push(root);
  return join(root, 'package');
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const sha256 = createHash('sha256').update('abcdef').digest('hex');

it('automatically resumes a disconnected identity download at its actual stored offset', async () => {
  const destination = file();
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('abc'));
              setTimeout(() => controller.error(new Error('connection lost')), 20);
            },
          }),
          { headers: { 'content-length': '6', etag: '"v1"' } },
        ),
    )
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers).toMatchObject({
        Range: 'bytes=3-',
        'If-Range': '"v1"',
        'accept-encoding': 'identity',
      });
      return new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
      });
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    sha256,
    network: { fetch },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(readFileSync(destination, 'utf8')).toBe('abcdef');
});

it.each(['ignored', 'invalid'] as const)('restarts cleanly when a range is %s', async (mode) => {
  const destination = file();
  writeFileSync(destination, 'abc');
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () =>
      mode === 'ignored'
        ? new Response('abcdef')
        : new Response('bad', { status: 206, headers: { 'content-range': 'bytes 1-3/6' } }),
    );
  if (mode === 'invalid')
    fetch.mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBeUndefined();
      return new Response('abcdef');
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    sha256,
    resumeExisting: true,
    network: { fetch },
  });
  expect(readFileSync(destination, 'utf8')).toBe('abcdef');
});

it('retries corrupt content from byte zero and accepts SHA-512 integrity only after verification', async () => {
  const destination = file();
  const integrity = 'sha512-' + createHash('sha512').update('abcdef').digest('base64');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('corrupt'))
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBeUndefined();
      return new Response('abcdef');
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    integrity,
    network: { fetch },
  });
  expect(readFileSync(destination, 'utf8')).toBe('abcdef');
});

it('verifies an already complete range cache instead of failing on HTTP 416', async () => {
  const destination = file();
  writeFileSync(destination, 'abcdef');
  const fetch = vi.fn(async () => new Response(null, { status: 416 }));
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    sha256,
    resumeExisting: true,
    network: { fetch },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves caller files and does not retry caller cancellation or unsafe redirects', async () => {
  const destination = file();
  writeFileSync(destination, 'owned by caller');
  const fetch = vi.fn(async () => new Response('abcdef'));
  await expect(
    downloadPackageFile({ source: 'https://example.com/package', destination, network: { fetch } }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(readFileSync(destination, 'utf8')).toBe('owned by caller');
  const controller = new AbortController();
  const cancelled = vi.fn(async () => {
    controller.abort();
    throw new Error('cancelled');
  });
  await expect(
    downloadPackageFile({
      source: 'https://example.com/package',
      destination: file(),
      signal: controller.signal,
      network: { fetch: cancelled },
    }),
  ).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledTimes(1);
  const redirect = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.example/package' },
      }),
  );
  await expect(
    downloadPackageFile({
      source: 'https://example.com/package',
      destination: file(),
      network: { fetch: redirect },
    }),
  ).rejects.toThrow('重定向');
  expect(redirect).toHaveBeenCalledTimes(1);
});
