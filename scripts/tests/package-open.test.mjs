import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import {
  availableInstallationPort,
  shouldUpgradePackage,
  openLocalBrowser,
} from '../lib/package-open.mjs';

it('chooses a free private port without stopping an unrelated listener', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const busy = server.address().port,
      chosen = await availableInstallationPort(busy);
    expect(chosen).not.toBe(busy);
    expect(server.listening).toBe(true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

it('opens equal or newer installed versions without downgrading and rejects ambiguous release order', () => {
  const current = { releaseId: 'old', manifest: { builtAt: '2026-10-26T01:00:00Z' } };
  expect(shouldUpgradePackage(current, current)).toBe(false);
  expect(
    shouldUpgradePackage(current, {
      releaseId: 'new',
      manifest: { builtAt: '2026-10-26T02:00:00Z' },
    }),
  ).toBe(true);
  expect(
    shouldUpgradePackage(current, {
      releaseId: 'older',
      manifest: { upstream: { builtAt: '2026-10-25T02:00:00Z' } },
    }),
  ).toBe(false);
  expect(() => shouldUpgradePackage(current, { releaseId: 'unknown', manifest: {} })).toThrow(
    '无法确认版本',
  );
  expect(() =>
    shouldUpgradePackage(current, { releaseId: 'ambiguous', manifest: current.manifest }),
  ).toThrow('构建时间相同');
});

it('opens only the local workbench through a fixed system association and exposes a usable URL on failure', async () => {
  const calls = [];
  await openLocalBrowser('http://127.0.0.1:12345/', async (...args) => calls.push(args));
  expect(calls[0][1].at(-1)).toBe(
    "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:CONTROL_PLANE_BROWSER_URL",
  );
  expect(calls[0][2].env.CONTROL_PLANE_BROWSER_URL).toBe('http://127.0.0.1:12345/');
  await expect(openLocalBrowser('https://example.com/', async () => {})).rejects.toThrow(
    '地址无效',
  );
  await expect(
    openLocalBrowser('http://127.0.0.1:12345/', async () => {
      throw Error('association unavailable');
    }),
  ).rejects.toThrow('请访问：http://127.0.0.1:12345/');
});
