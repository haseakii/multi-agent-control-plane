import { closeSync, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import type { InstanceLockRemover } from '../src/instance-lock-remover.js';

/** Single-process synthetic fixture for lifecycle tests, never a production lock boundary.
 * Native handle/race protection is exercised separately on Windows CI.
 */
export const fixtureLockRemover: InstanceLockRemover = {
  remove(filename, expected, token) {
    let fd: number | undefined;
    try {
      fd = openSync(filename, 'r');
      const stat = fstatSync(fd, { bigint: true });
      if (
        !stat.isFile() ||
        stat.dev.toString() !== expected.volumeId ||
        stat.ino.toString() !== expected.fileId ||
        (token !== undefined && JSON.parse(readFileSync(fd, 'utf8')).token !== token)
      )
        return { removed: false, reason: 'owner_changed' };
      closeSync(fd);
      fd = undefined;
      unlinkSync(filename);
      return { removed: true, reason: 'removed' };
    } catch {
      return { removed: false, reason: 'unavailable' };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};
