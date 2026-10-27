import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { InitializeResponse } from '@agentclientprotocol/sdk';

// CodeBuddy's ACP extension is read-only and does not restart login. Keep all
// returned account/credential fields inside this adapter; expose only a boolean.
// Verified against @tencent-ai/codebuddy-code 2.176.0: _codebuddy.ai/getUserInfo.
// Older/unsupported versions fall back to the ordinary authenticate response.
const Identity = z.object({ userInfo: z.object({ userId: z.string().min(1) }).optional() });
export function supportsCodeBuddyAuthStatus(initialized: InitializeResponse) {
  const methods = new Set((initialized.authMethods ?? []).map((method) => method.id));
  return ['internal', 'external', 'iOA', 'selfhosted'].every((id) => methods.has(id));
}

export async function readCodeBuddyAuthStatus(
  request: (method: string, params: object, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  let onAbort: (() => void) | undefined;
  try {
    bounded.throwIfAborted();
    const result = Identity.safeParse(
      await Promise.race([
        request('_codebuddy.ai/getUserInfo', {}, bounded),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(bounded.reason);
          bounded.addEventListener('abort', onAbort, { once: true });
        }),
      ]),
    );
    return result.success ? !!result.data.userInfo : undefined;
  } catch {
    // Unsupported versions, missing metadata and timeouts are never login success.
    return undefined;
  } finally {
    if (onAbort) bounded.removeEventListener('abort', onAbort);
  }
}

/** Recover a lost authenticate reply only after this connection reports a new signed-in state. */
export async function authenticateWithStatusRecovery(
  authenticate: () => Promise<unknown>,
  readStatus: (signal: AbortSignal) => Promise<boolean | undefined>,
  signal: AbortSignal,
  pollIntervalMs = 1000,
): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const initial = await readStatus(combined);
  let signedOut = initial === false;
  combined.throwIfAborted();
  if (initial === undefined) {
    await authenticate();
    return;
  }
  const recovery = async () => {
    for (;;) {
      await delay(pollIntervalMs, undefined, { signal: combined });
      const authenticated = await readStatus(combined);
      if (authenticated === undefined) {
        // Do not accumulate unresolved extension requests on unsupported/broken peers.
        combined.throwIfAborted();
        await new Promise<never>((_, reject) =>
          combined.addEventListener('abort', () => reject(combined.reason), { once: true }),
        );
      }
      if (authenticated === false) signedOut = true;
      if (authenticated === true && signedOut) return;
    }
  };
  try {
    // Never resend authenticate: CodeBuddy may sign out the old account on each call.
    await Promise.race([Promise.resolve().then(authenticate), recovery()]);
  } finally {
    controller.abort();
  }
}
