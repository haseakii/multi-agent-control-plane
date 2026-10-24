import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Fixed, bounded entry file. No caller-supplied path, symlink or directory traversal. */
export async function readWorkspacePage(rootPath: string): Promise<Uint8Array> {
  const normalize = (p: string) =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const root = await realpath(rootPath);
  if (normalize(root) !== normalize(rootPath)) throw new Error('Workspace identity changed.');
  const filename = join(root, 'index.html');
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 512 * 1024 ||
    normalize(await realpath(filename)) !== normalize(filename)
  )
    throw new Error('Preview requires a regular index.html of at most 512 KB.');
  const handle = await open(filename, 'r');
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size > 512 * 1024
    )
      throw new Error('Preview file identity changed.');
    const content = await handle.readFile();
    const after = await lstat(filename);
    if (
      content.length > 512 * 1024 ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.isSymbolicLink() ||
      normalize(await realpath(rootPath)) !== normalize(root) ||
      normalize(await realpath(filename)) !== normalize(filename)
    )
      throw new Error('Preview file identity changed.');
    return content;
  } finally {
    await handle.close();
  }
}
