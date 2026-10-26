import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { posix } from 'node:path';
import { z } from 'zod';
import type { WorkspacePreviewFiles } from '@control-plane/workspace';

export const LivePreviewInput = z
  .object({ entry: z.string().min(1).max(1024).optional() })
  .strict();
export const LivePreviewStatus = z.object({
  id: z.string(),
  taskId: z.string(),
  workspaceId: z.string(),
  rootPath: z.string(),
  state: z.enum(['ready', 'waiting']),
  url: z.string().url(),
  entry: z.string(),
  entries: z.array(z.string()),
  revision: z.string(),
  updatedAt: z.string(),
  fileCount: z.number(),
});
export const LivePreviewDocument = z.object({
  html: z.string().max(17 * 1024 * 1024),
  revision: z.string(),
  url: z.string().url(),
});
type Status = z.infer<typeof LivePreviewStatus>;
type Session = {
  status: Status;
  files: WorkspacePreviewFiles;
  server: Server;
  origin: string;
  parentOrigin: string;
  touched: number;
  candidate: string;
  candidateSince: number;
  automaticEntry: boolean;
  document?: { path: string; content: Uint8Array; mimeType: string };
  scan?: Promise<Status>;
};

/** Do not trust the host's ephemeral range: Windows can assign browser-blocked
 * ports such as 6000. Use the high dynamic range and retry only bind collisions.
 * Reference: Chromium net/base/port_util.cc (kRestrictedPorts).
 */
export async function listenBrowserPreview(
  server: Server,
  nextPort: () => number = () => randomInt(49152, 65536),
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = nextPort();
    if (!Number.isInteger(port) || port < 49152 || port > 65535) continue;
    try {
      await new Promise<void>((ok, no) => {
        const failed = (error: Error) => {
          server.off('listening', ready);
          no(error);
        };
        const ready = () => {
          server.off('error', failed);
          ok();
        };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  throw new Error('未找到可用于浏览器预览的本机端口，请稍后重试。');
}

/** Each workspace preview has its own loopback origin, with no control-plane routes or credentials. */
export class LivePreviewService {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Status>>();
  private readonly timer = setInterval(() => {
    for (const session of this.sessions.values())
      if (Date.now() - session.touched > 180_000) void this.stop(session);
  }, 30_000).unref();
  private closing = false;
  async start(input: {
    taskId: string;
    workspaceId: string;
    rootPath: string;
    parentOrigin: string;
    files: WorkspacePreviewFiles;
    entry?: string;
  }) {
    const key = `${input.taskId}:${input.workspaceId}:${input.entry ?? ''}`;
    const pending = this.starting.get(key);
    if (pending) return pending;
    const operation = this.open(input);
    this.starting.set(key, operation);
    try {
      return await operation;
    } finally {
      this.starting.delete(key);
    }
  }
  private async open(input: {
    taskId: string;
    workspaceId: string;
    rootPath: string;
    parentOrigin: string;
    files: WorkspacePreviewFiles;
    entry?: string;
  }) {
    if (this.closing) throw new Error('Preview is stopping.');
    const list = await input.files.list();
    const entries = list.filter((f) => f.path.endsWith('.html')).map((f) => f.path);
    const entry =
      input.entry ??
      ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html'].find((p) =>
        entries.includes(p),
      ) ??
      entries[0] ??
      'index.html';
    if (input.entry && !entries.includes(entry))
      throw new Error('预览入口不存在，请选择已有 HTML 页面。');
    const previous = [...this.sessions.values()].find(
      (s) =>
        s.status.taskId === input.taskId &&
        s.status.workspaceId === input.workspaceId &&
        s.status.entry === entry,
    );
    if (previous) return this.status(input.taskId, previous.status.id, input.workspaceId);
    if (this.sessions.size >= 16) throw new Error('预览数量已达上限，请稍后再试。');
    const parentOrigin = new URL(input.parentOrigin).origin;
    const session = {} as Session;
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader(
        'content-security-policy',
        `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${parentOrigin}`,
      );
      try {
        if (
          !['GET', 'HEAD'].includes(request.method ?? '') ||
          request.headers.host !== new URL(session.origin).host ||
          (request.headers.origin &&
            request.headers.origin !== 'null' &&
            request.headers.origin !== session.origin &&
            request.headers.origin !== parentOrigin)
        ) {
          response.writeHead(403).end('Preview request rejected.');
          return;
        }
        // The unguessable *.localhost host is a per-preview capability. Only public
        // workspace resources live here. Opaque sandbox documents need CORS for ESM;
        // credentials and the main application's APIs are never exposed by this listener.
        if (request.headers.origin === 'null') {
          response.setHeader('access-control-allow-origin', 'null');
          response.setHeader('vary', 'Origin');
        }
        // Parse before URL normalization so traversal cannot become a different allowed file.
        const raw = decodeURIComponent((request.url ?? '/').split('?')[0]!);
        if (
          !raw.startsWith('/') ||
          raw.split('/').some((p) => p === '..' || p === '.') ||
          /[\\:\x00-\x1f]/.test(raw)
        )
          throw new Error('Invalid path.');
        if (raw === '/__control_plane_preview_status__') {
          const state = await this.status(
            session.status.taskId,
            session.status.id,
            session.status.workspaceId,
          );
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(state));
          return;
        }
        const base = posix.dirname(session.status.entry);
        let relative = raw.slice(1);
        if (!relative) relative = posix.basename(session.status.entry);
        else if (relative.endsWith('/')) relative += 'index.html';
        const path = base === '.' ? relative : `${base}/${relative}`;
        // Prepare the entry before advertising readiness. This keeps initial iframe
        // navigation independent of slow platform directory probes. Only already
        // validated bytes are cached; other resources retain their read checks.
        const file =
          session.document?.path === path ? session.document : await session.files.read(path);
        response.setHeader('content-type', file.mimeType);
        let content: Uint8Array | string = file.content;
        if (file.mimeType.startsWith('text/html')) {
          const script = `<script>(()=>{const origin=${JSON.stringify(parentOrigin)};const report=message=>parent.postMessage({type:'control-plane-preview-error',message:String(message).slice(0,1000)},origin);addEventListener('DOMContentLoaded',()=>parent.postMessage({type:'control-plane-preview-ready'},origin),{once:true});addEventListener('error',e=>report(e.message||('资源加载失败：'+(e.target?.tagName||'unknown'))),true);addEventListener('unhandledrejection',e=>report(e.reason?.message||e.reason));if(parent===window){let revision=${JSON.stringify(session.status.revision)};const poll=async()=>{try{const r=await fetch('/__control_plane_preview_status__',{cache:'no-store'});const s=await r.json();if(s.state==='ready'&&s.revision!==revision){location.reload();return;}}catch{}setTimeout(poll,1200);};setTimeout(poll,1200);}})();</script>`;
          const html = new TextDecoder().decode(file.content);
          content = /^\s*<!doctype[^>]*>/i.test(html)
            ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${script}`)
            : script + html;
        }
        response.setHeader('content-length', Buffer.byteLength(content));
        response.writeHead(200).end(request.method === 'HEAD' ? undefined : content);
      } catch {
        response
          .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          .end('页面文件暂不可用，保存后会自动更新。');
      }
    });
    await listenBrowserPreview(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview listener unavailable.');
    const origin = `http://preview-${randomUUID().replaceAll('-', '')}.localhost:${address.port}`;
    Object.assign(session, {
      server,
      files: input.files,
      origin,
      parentOrigin,
      touched: Date.now(),
      candidate: '',
      candidateSince: 0,
      automaticEntry: !input.entry,
      status: {
        id: randomUUID(),
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        rootPath: input.rootPath,
        state: 'waiting',
        url: origin + '/',
        entry,
        entries,
        revision: '',
        updatedAt: new Date().toISOString(),
        fileCount: 0,
      },
    });
    this.sessions.set(session.status.id, session);
    if (this.closing) {
      await this.stop(session);
      throw new Error('Preview is stopping.');
    }
    return this.status(input.taskId, session.status.id, input.workspaceId);
  }
  async document(taskId: string, id: string, workspaceId: string) {
    const status = await this.status(taskId, id, workspaceId);
    const session = this.sessions.get(id);
    if (status.state !== 'ready' || !session?.document) throw new Error('正在等待页面文件。');
    const policy = `default-src 'none'; script-src ${session.origin} 'unsafe-inline'; style-src ${session.origin} 'unsafe-inline'; img-src ${session.origin} data: blob:; font-src ${session.origin} data:; media-src ${session.origin} blob:; connect-src ${session.origin}; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri ${session.origin}; form-action 'none'`;
    const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base href="${session.origin}/"><script>(()=>{const origin=${JSON.stringify(session.parentOrigin)};const send=(type,message)=>parent.postMessage({type,revision:${JSON.stringify(status.revision)},message:String(message||'').slice(0,1000)},origin);addEventListener('DOMContentLoaded',()=>send('control-plane-preview-ready'),{once:true});addEventListener('error',e=>send('control-plane-preview-error',e.message||'页面资源加载失败'),true);addEventListener('unhandledrejection',e=>send('control-plane-preview-error',e.reason?.message||e.reason));})();</script>`;
    const html = new TextDecoder().decode(session.document.content);
    return LivePreviewDocument.parse({
      html: /^\s*<!doctype[^>]*>/i.test(html)
        ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${bootstrap}`)
        : bootstrap + html,
      revision: status.revision,
      url: status.url,
    });
  }
  async status(taskId: string, id: string, workspaceId: string): Promise<Status> {
    const session = this.sessions.get(id);
    if (!session || session.status.taskId !== taskId || session.status.workspaceId !== workspaceId)
      throw new Error('预览已过期，请重新连接。');
    session.touched = Date.now();
    if (session.scan) return session.scan;
    session.scan = (async () => {
      const files = await session.files.list();
      const entries = files.filter((f) => f.path.endsWith('.html')).map((f) => f.path);
      if (session.automaticEntry && !entries.includes(session.status.entry) && entries.length)
        session.status.entry =
          ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html'].find((p) =>
            entries.includes(p),
          ) ?? entries[0]!;
      const base = posix.dirname(session.status.entry);
      const selected = files.filter((f) => base === '.' || f.path.startsWith(base + '/'));
      const hash = createHash('sha256').update(JSON.stringify(selected)).digest('hex');
      const ready = selected.some((f) => f.path === session.status.entry);
      // Two matching observations avoid reloading halfway through an editor's save sequence.
      if (
        !session.status.revision ||
        (hash === session.candidate && Date.now() - session.candidateSince >= 350)
      ) {
        if (ready && (session.status.revision !== hash || !session.document)) {
          const document = await session.files.read(session.status.entry);
          session.document = { path: session.status.entry, ...document };
        } else if (!ready) delete session.document;
        if (session.status.revision !== hash) session.status.updatedAt = new Date().toISOString();
        session.status.revision = hash;
        session.status.state = ready ? 'ready' : 'waiting';
      }
      if (session.candidate !== hash) session.candidateSince = Date.now();
      session.candidate = hash;
      session.status.entries = entries;
      session.status.fileCount = selected.length;
      return LivePreviewStatus.parse(session.status);
    })();
    try {
      return await session.scan;
    } catch (error) {
      await this.stop(session);
      throw error;
    } finally {
      delete session.scan;
    }
  }
  private async stop(session: Session) {
    this.sessions.delete(session.status.id);
    await new Promise<void>((ok) => {
      session.server.close(() => ok());
      session.server.closeAllConnections();
    });
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.starting.values());
    await Promise.all([...this.sessions.values()].map((s) => this.stop(s)));
  }
}
