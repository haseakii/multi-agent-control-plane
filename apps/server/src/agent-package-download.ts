import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  openSync,
  statSync,
} from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { NetworkSettingsService } from './network-settings.js';
import { AgentPackageInstallError } from './agent-package-error.js';

export type DownloadProgress = { receivedBytes: number; totalBytes?: number };
type Options = {
  source: string;
  destination: string;
  network: Pick<NetworkSettingsService, 'fetch'>;
  sha256?: string | undefined;
  integrity?: string | undefined;
  resumeExisting?: boolean;
  maxBytes?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
};

async function verified(filename: string, options: Options) {
  const sri = options.integrity?.split(/\s+/).find((value) => value.startsWith('sha512-'));
  if (options.integrity && (!sri || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(sri)))
    throw new AgentPackageInstallError('程序包缺少有效的 SHA-512 校验信息。');
  const hash = createHash(sri ? 'sha512' : 'sha256');
  for await (const block of createReadStream(filename)) hash.update(block);
  const actual = hash.digest(sri ? 'base64' : 'hex');
  return sri
    ? actual === sri.slice('sha512-'.length)
    : !options.sha256 || actual === options.sha256.toLowerCase();
}

async function request(options: Options, signal: AbortSignal, headers: Record<string, string>) {
  let url = new URL(options.source);
  const origin = url.origin;
  for (let hop = 0; hop < 6; hop++) {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.origin !== origin &&
        ![
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'github.com',
        ].includes(url.hostname))
    )
      throw new AgentPackageInstallError('下载重定向不受支持，原文件保留。');
    const response = await options.network.fetch(url, { redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new AgentPackageInstallError('下载重定向缺少目标地址。');
    url = new URL(location, url);
  }
  throw new AgentPackageInstallError('下载重定向次数过多。');
}

/** Resume interrupted public package downloads and verify the complete archive before extraction. */
export async function downloadPackageFile(options: Options) {
  options.signal?.throwIfAborted();
  if (
    options.integrity &&
    !options.integrity.split(/\s+/).some((value) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value))
  )
    throw new AgentPackageInstallError('程序包缺少有效的 SHA-512 校验信息。');
  if (options.resumeExisting && !(options.sha256 || options.integrity))
    throw new AgentPackageInstallError('已有下载文件需要完整性校验信息才能恢复。');
  let owned = !!options.resumeExisting && existsSync(options.destination);
  if (
    owned &&
    (!lstatSync(options.destination).isFile() || lstatSync(options.destination).isSymbolicLink())
  )
    throw new AgentPackageInstallError('下载缓存不是普通文件。');
  let resume = true;
  let etag: string | null = null;
  let failure: unknown;
  for (let attempt = 0; attempt < (options.maxAttempts ?? 3); attempt++) {
    options.signal?.throwIfAborted();
    const stalled = new AbortController();
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 180_000),
      stalled.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let fatal = false;
    try {
      let bytes = owned && resume ? statSync(options.destination).size : 0;
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      if (bytes) {
        headers.Range = `bytes=${bytes}-`;
        if (etag && !etag.startsWith('W/')) headers['If-Range'] = etag;
      }
      response = await request(options, signal, headers);
      if (response.status === 416 && bytes && (options.sha256 || options.integrity)) {
        if (await verified(options.destination, options)) {
          options.signal?.throwIfAborted();
          options.progress?.({ receivedBytes: bytes, totalBytes: bytes });
          return;
        }
        resume = false;
        throw new Error('Incomplete range cache.');
      }
      if (!response.ok || !response.body) throw new Error('Package download failed.');
      const encoding = response.headers.get('content-encoding');
      const encoded = !!encoding && encoding.toLowerCase() !== 'identity';
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (bytes && response.status === 206) {
        if (encoded || !range || Number(range[1]) !== bytes) {
          resume = false;
          throw new AgentPackageInstallError('下载续传位置不符，正在重新获取程序包。');
        }
      } else {
        // A server may ignore Range or reject If-Range after a changed ETag.
        bytes = 0;
        if (response.status === 206) throw new Error('Unexpected partial response.');
      }
      resume = !encoded;
      etag = response.headers.get('etag');
      const length = Number(response.headers.get('content-length'));
      let totalBytes =
        !encoded && range
          ? Number(range[3])
          : !encoded && Number.isSafeInteger(length) && length > 0
            ? length
            : undefined;
      if (!owned) {
        const fd = openSync(options.destination, 'wx');
        closeSync(fd);
        owned = true;
      }
      const report = () =>
        options.progress?.({ receivedBytes: bytes, ...(totalBytes ? { totalBytes } : {}) });
      let lastReport = performance.now();
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stalled.abort(), options.stallTimeoutMs ?? 30_000);
      };
      touch();
      report();
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(block: Buffer, _encoding, callback) {
            touch();
            bytes += block.byteLength;
            if (bytes > (options.maxBytes ?? 512 * 1024 * 1024)) {
              fatal = true;
              callback(new AgentPackageInstallError('程序包超过下载大小限制，未执行安装。'));
              return;
            }
            if (totalBytes && bytes > totalBytes) totalBytes = undefined;
            if (performance.now() - lastReport >= 250) {
              lastReport = performance.now();
              report();
            }
            callback(null, block);
          },
        }),
        createWriteStream(options.destination, { flags: bytes ? 'a' : 'w' }),
        { signal },
      );
      clearTimeout(timer);
      if (!bytes || !(await verified(options.destination, options))) {
        resume = false;
        throw new AgentPackageInstallError(
          '程序包内容为空或 SHA-256/SHA-512 校验失败，未解压或启动。',
        );
      }
      options.signal?.throwIfAborted();
      if (totalBytes !== bytes) totalBytes = undefined;
      report();
      return;
    } catch (error) {
      options.signal?.throwIfAborted();
      failure = error;
      // Never retry writes to an existing caller-owned file or unsafe download URLs.
      if (
        fatal ||
        (error as NodeJS.ErrnoException).code === 'EEXIST' ||
        (error instanceof AgentPackageInstallError && error.message.includes('重定向'))
      )
        throw error;
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
  }
  if (failure instanceof AgentPackageInstallError) throw failure;
  throw new AgentPackageInstallError('程序包自动下载恢复未完成，请检查网络或代理后重新安装。');
}
