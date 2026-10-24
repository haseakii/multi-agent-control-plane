import { request } from 'node:http';

/** Exercise the real preview listener while matching browser loopback resolution.
 * The original Host is retained, so preview origin validation still runs.
 */
export async function previewFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: target.pathname + target.search,
        headers: { host: target.host, ...init?.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers as Record<string, string>,
            }),
          ),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Preview request timed out')));
    req.end();
  });
}
