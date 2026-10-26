export type FileScope = { taskId: string; rootPath: string };
export type FileFocus = { taskId: string; path: string };
const prefix = '#workspace-file=';
function relativePath(value: string) {
  return (
    !!value &&
    !value.startsWith('/') &&
    !/[\u0000-\u001f:?#]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
export function resolveWorkspaceFile(value: string, scopes: FileScope[]): FileFocus | undefined {
  let path = value;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.host || url.search) return;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return;
    }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
    try {
      path = decodeURIComponent(path);
    } catch {
      return;
    }
  }
  path = path.replaceAll('\\', '/').replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '');
  if (/[\u0000-\u001f?#]/.test(path) || path.startsWith('//') || path.split('/').includes('..'))
    return;
  const matches = scopes.flatMap((scope) => {
    const root = scope.rootPath.replaceAll('\\', '/').replace(/\/$/, '');
    const windows = /^[a-z]:\//i.test(root);
    const starts = windows
      ? path.toLowerCase().startsWith(root.toLowerCase() + '/')
      : path.startsWith(root + '/');
    const relative = starts ? path.slice(root.length + 1) : '';
    return relativePath(relative) ? [{ taskId: scope.taskId, path: relative }] : [];
  });
  // A shared root can belong to multiple conversation rounds. Don't guess a historical owner.
  const unique = [...new Map(matches.map((match) => [JSON.stringify(match), match])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}
export const workspaceFileHref = (focus: FileFocus) =>
  prefix + encodeURIComponent(JSON.stringify(focus));
export function parseWorkspaceFileHref(href: string, taskIds: string[]): FileFocus | undefined {
  if (!href.startsWith(prefix)) return;
  try {
    const value = JSON.parse(decodeURIComponent(href.slice(prefix.length)));
    if (
      typeof value.taskId === 'string' &&
      taskIds.includes(value.taskId) &&
      typeof value.path === 'string' &&
      relativePath(value.path)
    )
      return { taskId: value.taskId, path: value.path };
  } catch {
    /* Untrusted message content is not navigation authority. */
  }
}
type Node = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};
/** Runs before sanitation. Only converts task-scoped local anchors, never images or raw HTML text. */
export function rehypeWorkspaceFiles(scopes: FileScope[]) {
  return (tree: unknown) => {
    const walk = (node: Node) => {
      if (
        node.type === 'element' &&
        node.tagName === 'a' &&
        typeof node.properties?.href === 'string'
      ) {
        const focus = resolveWorkspaceFile(node.properties.href, scopes);
        if (focus) node.properties.href = workspaceFileHref(focus);
      }
      node.children?.forEach(walk);
    };
    walk(tree as Node);
  };
}
