import { Agent, request } from 'node:http';
import { Readable } from 'node:stream';

/** Explicit direct local transport: an inherited provider proxy must never receive bridge grants. */
export const loopbackFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new TypeError('Expected a local HTTP request.');
  const source = input instanceof Request ? input : undefined;
  const method = init.method ?? source?.method ?? 'GET';
  const body =
    init.body ??
    (source && method !== 'GET' && method !== 'HEAD' ? await source.text() : undefined);
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== 'string' &&
    !(body instanceof Uint8Array)
  )
    throw TypeError('Unsupported local request body.');
  const agent = new Agent({ proxyEnv: {} } as import('node:http').AgentOptions & {
    proxyEnv: Record<string, string>;
  });
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: Object.fromEntries(new Headers(init.headers ?? source?.headers)),
        signal: init.signal ?? source?.signal ?? undefined,
        agent,
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400) {
          res.destroy();
          agent.destroy();
          reject(new Error('Local bridge redirects are not followed.'));
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        res.on('close', () => agent.destroy());
        resolve(
          new Response(
            method === 'HEAD' || [204, 205, 304].includes(res.statusCode ?? 0)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status: res.statusCode ?? 502, headers },
          ),
        );
      },
    );
    req.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    if (body) req.write(body);
    req.end();
  });
};
