import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { WorkspacePreviewFiles } from '@control-plane/workspace';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const blocked =
  /^(?:node_modules|vendor|coverage|secrets?|credentials?|package(?:-lock)?\.json|.*\.config\.[^/]+|tsconfig[^/]*\.json)$/i;
const normal = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const partsOf = (path: string) => {
  const parts = path.split('/');
  if (
    !path ||
    path.length > 1024 ||
    /[\\:\x00-\x1f]/.test(path) ||
    parts.some(
      (p) => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith(' ') || blocked.test(p),
    )
  )
    throw new Error('Preview path is not a public web file.');
  return parts;
};
export class LocalWorkspacePreviewFiles implements WorkspacePreviewFiles {
  constructor(
    private readonly root: string,
    private readonly validate: () => Promise<void>,
  ) {}
  private async identity(parts: string[]) {
    await this.validate();
    if (normal(await realpath(this.root)) !== normal(this.root))
      throw new Error('Workspace identity changed.');
    let path = this.root;
    for (const part of parts) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink() || normal(await realpath(path)) !== normal(path))
        throw new Error('Preview links are not supported.');
    }
    return path;
  }
  async list() {
    await this.identity([]);
    const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
    let visited = 0;
    const walk = async (dir: string, prefix = '', depth = 0): Promise<void> => {
      if (depth > 12) return;
      if ((await lstat(dir)).isSymbolicLink() || normal(await realpath(dir)) !== normal(dir))
        throw new Error('Preview directory identity changed.');
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++visited > 12000) throw new Error('预览目录过大，请将页面放入 public 或 dist 目录。');
        const path = prefix + entry.name;
        try {
          partsOf(path);
        } catch {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), path + '/', depth + 1);
          continue;
        }
        if (!entry.isFile() || !types[extname(entry.name).toLowerCase()]) continue;
        try {
          const stat = await lstat(join(dir, entry.name));
          if (stat.isFile() && stat.size <= 16 * 1024 * 1024)
            files.push({ path, size: stat.size, modifiedAt: stat.mtimeMs });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    };
    await walk(this.root);
    await this.identity([]);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(path: string) {
    const parts = partsOf(path),
      mimeType = types[extname(path).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported preview file type.');
    const filename = await this.identity(parts),
      before = await lstat(filename);
    if (!before.isFile() || before.size > 16 * 1024 * 1024)
      throw new Error('Preview file is too large.');
    const handle = await open(filename, 'r');
    try {
      const current = await handle.stat();
      if (
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size > 16 * 1024 * 1024
      )
        throw new Error('Preview file changed.');
      const content = await handle.readFile();
      const after = await lstat(await this.identity(parts));
      if (
        content.length > 16 * 1024 * 1024 ||
        after.dev !== current.dev ||
        after.ino !== current.ino
      )
        throw new Error('Preview file changed.');
      return { content, mimeType };
    } finally {
      await handle.close();
    }
  }
}
