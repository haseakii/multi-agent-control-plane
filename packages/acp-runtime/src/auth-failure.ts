/** Known transient failures only; never publish provider messages or retry a login rejection. */
export function transientAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const item = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
  return (
    item.code === -32603 ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(
      String(item.code ?? item.cause?.code),
    ) ||
    (typeof item.message === 'string' &&
      /^(request timed out|context deadline exceeded|the model is currently unreachable\.?|internal error encountered\.?)$/i.test(
        item.message.trim(),
      ))
  );
}
