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

it('continues a capped range until the entire object is present even without a checksum', async () => {
  const destination = file();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('abc', { headers: { 'content-length': '6', etag: '"v1"' } }),
    )
    .mockResolvedValueOnce(
      new Response('de', {
        status: 206,
        headers: { 'content-range': 'bytes 3-4/6', 'content-length': '2', etag: '"v1"' },
      }),
    )
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBe('bytes=5-');
      return new Response('f', {
        status: 206,
        headers: { 'content-range': 'bytes 5-5/6', 'content-length': '1', etag: '"v1"' },
      });
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    network: { fetch },
  });
  expect(readFileSync(destination, 'utf8')).toBe('abcdef');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([404, 401, 403])('does not retry permanent HTTP %s failures', async (status) => {
  const fetch = vi.fn(async () => new Response(null, { status }));
  await expect(
    downloadPackageFile({
      source: 'https://example.com/package',
      destination: file(),
      network: { fetch },
    }),
  ).rejects.toThrow('返回错误');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('recovers transient HTTP errors and an incomplete body using the exact missing range', async () => {
  const destination = file();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response('abc', { headers: { 'content-length': '6' } }))
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBe('bytes=3-');
      return new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
      });
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    network: { fetch },
    sha256,
  });
  expect(readFileSync(destination, 'utf8')).toBe('abcdef');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('never appends unidentifiable content after a checksum-free disconnect', async () => {
  const destination = file();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('abc', { headers: { 'content-length': '6' } }))
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBeUndefined();
      return new Response('uvwxyz');
    });
  await downloadPackageFile({
    source: 'https://example.com/package',
    destination,
    network: { fetch },
  });
  expect(readFileSync(destination, 'utf8')).toBe('uvwxyz');
});

it('rejects invalid checksums, invalid limits and oversized caches before requesting or truncating files', async () => {
  const destination = file();
  writeFileSync(destination, 'retained');
  const fetch = vi.fn();
  for (const options of [
    { sha256: 'bad' },
    { integrity: 'sha512-bad' },
    { maxAttempts: 0 },
    { timeoutMs: NaN },
    { maxBytes: -1 },
  ])
    await expect(
      downloadPackageFile({
        source: 'https://example.com/package',
        destination,
        network: { fetch },
        ...options,
      }),
    ).rejects.toThrow();
  await expect(
    downloadPackageFile({
      source: 'https://example.com/package',
      destination,
      network: { fetch },
      resumeExisting: true,
      sha256,
      maxBytes: 3,
    }),
  ).rejects.toThrow('大小限制');
  expect(fetch).not.toHaveBeenCalled();
  expect(readFileSync(destination, 'utf8')).toBe('retained');
});

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

it('verifies an already complete range cache before issuing a network request', async () => {
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
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves caller files and does not retry caller cancellation or unsafe redirects', async () => {
  const destination = file();
  writeFileSync(destination, 'owned by caller');
  const fetch = vi.fn(async () => new Response('abcdef'));
  await expect(
    downloadPackageFile({ source: 'https://example.com/package', destination, network: { fetch } }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fetch).not.toHaveBeenCalled();
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
