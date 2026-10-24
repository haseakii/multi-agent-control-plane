import { z } from 'zod';

const recipientUnavailable = {
  ok: false,
  error: 'Recipient task is ending or unavailable; retry the message.',
  statusCode: 409,
  code: 'RECIPIENT_UNAVAILABLE',
  retryable: true,
} as const;

/** Only fixed, allowlisted errors may cross the service/HTTP/MCP error boundary. */
export class FleetRecipientUnavailableError extends Error {
  readonly statusCode = 409;
  constructor() {
    super(recipientUnavailable.error);
    this.name = 'FleetRecipientUnavailableError';
  }
}

export const FleetRetryableFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.literal(recipientUnavailable.error),
    statusCode: z.literal(409),
    code: z.literal('RECIPIENT_UNAVAILABLE'),
    retryable: z.literal(true),
  })
  .strict();
export type FleetRetryableFailure = z.infer<typeof FleetRetryableFailureSchema>;

const policyDenied = {
  ok: false,
  error: 'Fleet tool policy denied.',
  statusCode: 403,
  code: 'POLICY_DENIED',
  retryable: false,
} as const;
const sessionUnbound = {
  ok: false,
  error: 'Bridge grant is not bound to an ACP session yet.',
  statusCode: 409,
  code: 'SESSION_UNBOUND',
  retryable: true,
} as const;

export class FleetPolicyDeniedError extends Error {
  constructor() {
    super(policyDenied.error);
    this.name = 'FleetPolicyDeniedError';
  }
}
export class FleetSessionUnboundError extends Error {
  constructor() {
    super(sessionUnbound.error);
    this.name = 'FleetSessionUnboundError';
  }
}
export type FleetServiceFailure =
  | FleetRetryableFailure
  | typeof policyDenied
  | typeof sessionUnbound;

export function fleetServiceFailure(error: unknown): FleetServiceFailure | undefined {
  // Use canonical data, never error.message or arbitrary statusCode properties.
  if (error instanceof FleetRecipientUnavailableError) return { ...recipientUnavailable };
  if (error instanceof FleetPolicyDeniedError) return { ...policyDenied };
  if (error instanceof FleetSessionUnboundError) return { ...sessionUnbound };
  return undefined;
}
