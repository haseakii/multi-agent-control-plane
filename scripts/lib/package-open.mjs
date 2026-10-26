import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

/** Invoke the system URL association without quoting a browser command through CMD. */
export async function openLocalBrowser(address, run = promisify(execFile)) {
  const url = new URL(address);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('工作台浏览器地址无效。');
  try {
    await run(
      path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:CONTROL_PLANE_BROWSER_URL",
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 64000,
        env: { ...process.env, CONTROL_PLANE_BROWSER_URL: url.href },
      },
    );
  } catch {
    throw Error('工作台已启动，但浏览器未能打开。请访问：' + url.href);
  }
}

/** A fresh private installation chooses its port once; existing client URLs stay stable. */
export async function availableInstallationPort(preferred = 3000) {
  const listen = (port) =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        const chosen = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(chosen)));
      });
    });
  try {
    return await listen(preferred);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    return listen(0);
  }
}

function buildTime(manifest) {
  const value = Date.parse(manifest.builtAt ?? manifest.upstream?.builtAt ?? '');
  if (!Number.isFinite(value)) throw Error('无法确认版本先后，原安装保留。请使用显式升级入口。');
  return value;
}

/** Opening an older downloaded executable must never downgrade an existing installation. */
export function shouldUpgradePackage(current, offered) {
  if (current.releaseId === offered.releaseId) return false;
  const before = buildTime(current.manifest),
    after = buildTime(offered.manifest);
  if (before === after) throw Error('两个版本的构建时间相同，未自动替换。请使用显式升级入口。');
  return after > before;
}
