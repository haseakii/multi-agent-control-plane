import { closeSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';

/** Recognize Node entries without executing them or searching PATH. */
export function isNodeEntrypoint(filename: string): boolean {
  if (/\.(?:c|m)?js$/i.test(filename)) return true;
  if (extname(filename)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(filename, 'r');
    const bytes = Buffer.alloc(256);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return /^#![ \t]*\/usr\/bin\/env[ \t]+node(?:[ \t\r\n]|$)/.test(
      bytes.subarray(0, count).toString('utf8'),
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
