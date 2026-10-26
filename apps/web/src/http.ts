export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new HttpError(response.status, payload.error ?? `HTTP ${response.status}`);
  return payload;
}
