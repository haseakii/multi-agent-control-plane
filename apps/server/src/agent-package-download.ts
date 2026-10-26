import { closeSync, createWriteStream, existsSync, lstatSync, openSync, statSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { NetworkSettingsService } from './network-settings.js';
import { AgentPackageInstallError } from './agent-package-error.js';
import {
  packageChecksums,
  verifyPackageChecksum,
  type PackageChecksum,
} from './agent-package-integrity.js';

export type DownloadProgress = { receivedBytes: number; totalBytes?: number };
type Options = PackageChecksum & {
  source: string;
  destination: string;
  network: Pick<NetworkSettingsService, 'fetch'>;
  resumeExisting?: boolean;
  maxBytes?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  retryDelayMs?: number;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
};
class DownloadFailure extends AgentPackageInstallError {
  constructor(
    message: string,
    readonly retryable = false,
    readonly reset = false,
  ) {
    super(message);
  }
}
function limit(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new AgentPackageInstallError('下载限制参数无效。');
  return result;
}
function safeUrl(source: string, origin?: string) {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new DownloadFailure('程序包下载地址无效。');
  }
  const githubAsset =
    origin === 'https://github.com' &&
    ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
      url.hostname,
    );
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (origin && url.origin !== origin && !githubAsset)
  )
    throw new DownloadFailure('下载重定向不受支持，原文件保留。');
  return url;
}
async function request(options: Options, signal: AbortSignal, headers: Record<string, string>) {
  let url = safeUrl(options.source);
  const origin = url.origin;
  for (let hop = 0; hop < 6; hop++) {
    const response = await options.network.fetch(url, { redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new DownloadFailure('下载重定向缺少目标地址。');
    let destination: string;
    try {
      destination = new URL(location, url).href;
    } catch {
      throw new DownloadFailure('下载重定向地址无效。');
    }
    url = safeUrl(destination, origin);
  }
  throw new DownloadFailure('下载重定向次数过多。');
}
function contentRange(value: string | null) {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return;
  const [start, end, total] = match.slice(1).map(Number) as [number, number, number];
  if ([start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end)
    return { start, end, total };
}
const strongEtag = (etag: string | null) => (etag && /^"[^"\r\n]*"$/.test(etag) ? etag : null);

/** Bound retries, resume only identifiable content, and verify complete archives before extraction. */
export async function downloadPackageFile(options: Options) {
  options.signal?.throwIfAborted();
  safeUrl(options.source);
  const checks = packageChecksums(options);
  const maxBytes = limit(options.maxBytes, 512 * 1024 * 1024);
  const attempts = limit(options.maxAttempts, 3, 10);
  const timeoutMs = limit(options.timeoutMs, 180_000, 2_147_483_647);
  const stallMs = limit(options.stallTimeoutMs, 30_000, 2_147_483_647);
  const retryMs = limit(options.retryDelayMs, 200, 30_000);
  if (options.resumeExisting && !checks.length)
    throw new AgentPackageInstallError('已有下载文件需要完整性校验信息才能恢复。');
  if (options.resumeExisting && existsSync(options.destination)) {
    const info = lstatSync(options.destination);
    if (!info.isFile() || info.isSymbolicLink())
      throw new AgentPackageInstallError('下载缓存不是普通文件。');
    if (info.size > maxBytes) throw new DownloadFailure('程序包超过下载大小限制，未执行安装。');
    if (info.size && (await verifyPackageChecksum(options.destination, checks, options.signal))) {
      options.progress?.({ receivedBytes: info.size, totalBytes: info.size });
      return;
    }
  } else {
    const fd = openSync(options.destination, 'wx');
    closeSync(fd);
  }
  let resume = true,
    etag: string | null = null,
    failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    options.signal?.throwIfAborted();
    const stalled = new AbortController();
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      stalled.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), stallMs);
    };
    try {
      let bytes = resume ? statSync(options.destination).size : 0;
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      if (bytes) {
        headers.Range = `bytes=${bytes}-`;
        if (etag) headers['If-Range'] = etag;
      }
      touch();
      response = await request(options, signal, headers);
      if (response.status === 416 && bytes) {
        if (checks.length && (await verifyPackageChecksum(options.destination, checks, signal))) {
          options.progress?.({ receivedBytes: bytes, totalBytes: bytes });
          return;
        }
        throw new DownloadFailure('下载缓存不完整，正在重新获取程序包。', true, true);
      }
      if (!response.ok)
        throw new DownloadFailure(
          '程序包下载服务返回错误。',
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      if (!response.body) throw new DownloadFailure('程序包下载内容为空。', true, true);
      const encoding = response.headers.get('content-encoding');
      const encoded = !!encoding && encoding.toLowerCase() !== 'identity';
      const range = contentRange(response.headers.get('content-range'));
      const rawLength = response.headers.get('content-length');
      const length = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
      if (response.status === 206) {
        if (
          !bytes ||
          encoded ||
          !range ||
          range.start !== bytes ||
          (!checks.length && strongEtag(response.headers.get('etag')) !== etag) ||
          (length !== undefined && length !== range.end - range.start + 1)
        )
          throw new DownloadFailure('下载续传位置不符，正在重新获取程序包。', true, true);
      } else {
        bytes = 0;
      }
      etag = strongEtag(response.headers.get('etag'));
      resume = !encoded && (!!checks.length || !!etag);
      const expectedEnd = !encoded
        ? response.status === 206
          ? range!.end + 1
          : length
        : undefined;
      const total = !encoded ? (response.status === 206 ? range!.total : length) : undefined;
      if (total !== undefined && (!Number.isSafeInteger(total) || total > maxBytes))
        throw new DownloadFailure('程序包超过下载大小限制，未执行安装。');
      const report = () =>
        options.progress?.({
          receivedBytes: bytes,
          ...(total !== undefined ? { totalBytes: total } : {}),
        });
      let lastReport = performance.now();
      report();
      touch();
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(block: Buffer, _encoding, callback) {
            touch();
            bytes += block.byteLength;
            if (bytes > maxBytes)
              return callback(new DownloadFailure('程序包超过下载大小限制，未执行安装。'));
            if (expectedEnd !== undefined && bytes > expectedEnd)
              return callback(
                new DownloadFailure('程序包响应长度不符，正在重新获取。', true, true),
              );
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
      if (expectedEnd !== undefined && bytes !== expectedEnd)
        throw new DownloadFailure('程序包下载尚未完成，正在自动恢复。', true);
      if (total !== undefined && bytes !== total)
        throw new DownloadFailure('程序包分段下载尚未完成，正在自动恢复。', true);
      if (!bytes || !(await verifyPackageChecksum(options.destination, checks, signal)))
        throw new DownloadFailure(
          '程序包内容为空或 SHA-256/SHA-512 校验失败，未解压或启动。',
          true,
          true,
        );
      options.signal?.throwIfAborted();
      report();
      return;
    } catch (error) {
      options.signal?.throwIfAborted();
      failure = error;
      if (error instanceof DownloadFailure) {
        if (!error.retryable) throw error;
        if (error.reset) resume = false;
      }
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (
        typeof code === 'string' &&
        ['EEXIST', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE', 'ENOENT', 'EISDIR'].includes(
          code,
        )
      )
        throw error;
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
    if (attempt + 1 < attempts)
      await delay(Math.min(retryMs * 2 ** attempt, 30_000), undefined, { signal: options.signal });
  }
  if (failure instanceof AgentPackageInstallError) throw failure;
  throw new AgentPackageInstallError('程序包自动下载恢复未完成，请检查网络或代理后重新安装。');
}
