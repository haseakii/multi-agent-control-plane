import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { AgentPackageInstallError } from './agent-package-error.js';

export type PackageChecksum = { sha256?: string | undefined; integrity?: string | undefined };
/** Parse before any network or file mutation. npm SRI may advertise several digests. */
export function packageChecksums(options: PackageChecksum) {
  const checks: { algorithm: 'sha256' | 'sha512'; expected: Buffer[] }[] = [];
  if (options.sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(options.sha256))
      throw new AgentPackageInstallError('程序包 SHA-256 校验信息无效。');
    checks.push({ algorithm: 'sha256', expected: [Buffer.from(options.sha256, 'hex')] });
  }
  if (options.integrity !== undefined) {
    const expected = options.integrity
      .split(/\s+/)
      .filter((value) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value))
      .map((value) => Buffer.from(value.slice(7), 'base64'))
      .filter((value) => value.length === 64);
    if (!expected.length) throw new AgentPackageInstallError('程序包缺少有效的 SHA-512 校验信息。');
    checks.push({ algorithm: 'sha512', expected });
  }
  return checks;
}
export async function verifyPackageChecksum(
  filename: string,
  checks: ReturnType<typeof packageChecksums>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!checks.length) return true;
  const hashes = checks.map((check) => createHash(check.algorithm));
  for await (const block of createReadStream(filename, { signal }))
    hashes.forEach((hash) => hash.update(block));
  signal?.throwIfAborted();
  return checks.every((check, index) => {
    const actual = hashes[index]!.digest();
    return check.expected.some((expected) => timingSafeEqual(actual, expected));
  });
}
