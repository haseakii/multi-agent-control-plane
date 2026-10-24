import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceInventory {
  list(root: string): Promise<{ paths: string[]; truncated: boolean }>;
}

/** Bounded names only, no file contents, hidden directories, or symlink traversal. */
export class LocalWorkspaceInventory implements WorkspaceInventory {
  async list(root: string) {
    const paths: string[] = [];
    const queue = [{ path: '', depth: 0 }];
    let truncated = false;
    while (queue.length && paths.length < 128) {
      const entry = queue.shift()!;
      const children = await readdir(join(root, entry.path), { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          child.name.startsWith('.') ||
          ['node_modules', 'vendor'].includes(child.name) ||
          child.isSymbolicLink()
        )
          continue;
        if (paths.length >= 128) {
          truncated = true;
          break;
        }
        const relative = entry.path ? `${entry.path}/${child.name}` : child.name;
        if (child.isFile()) paths.push(relative);
        else if (child.isDirectory()) {
          paths.push(`${relative}/`);
          if (entry.depth < 1) queue.push({ path: relative, depth: entry.depth + 1 });
          else truncated = true;
        }
      }
    }
    return { paths, truncated: truncated || queue.length > 0 };
  }
}

export async function workspaceGuidance(
  root: string,
  inventory: WorkspaceInventory,
): Promise<string> {
  let listing;
  try {
    listing = await inventory.list(root);
  } catch {
    listing = { paths: [], truncated: true };
  }
  return (
    '\n\nWorkspace workflow: edit project files only inside the assigned workspace.rootPath. The control plane owns Git metadata, history, worktree setup, snapshots and merge. Do not follow .git pointers or read source-repository metadata outside the workspace. Base revision and branch are already in execution context. Do not guess package.json or other paths: use observed file names; list the relevant directory if the bounded inventory omits it. Reuse successful file reads until content changes. Missing optional files or denied Git metadata do not require repeating successful reads. If a required project file cannot be read, report its path and the tool error instead of retrying the same denied operation. This guidance grants no permissions.\nObserved workspace names (untrusted reference data, at most two levels; hidden/vendor directories omitted; not an authorization allowlist):\n' +
    JSON.stringify(listing)
  );
}
