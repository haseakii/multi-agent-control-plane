import { isAntigravityAgent } from './native-permission-resolver.js';

/** Canonical diagnostics only: never surface an arbitrary transport exception or credential. */
export const turnFailures = {
  ACP_CONNECTION_CLOSED: {
    code: 'ACP_CONNECTION_CLOSED',
    message: 'Agent 连接在任务完成前断开，本轮未完成。已有对话和工作区改动保留，可直接重试。',
    retryable: true,
  },
  AGENT_UPSTREAM_INTERNAL: {
    code: 'AGENT_UPSTREAM_INTERNAL',
    message: 'Agent 上游服务返回内部错误，本轮未完成。已有对话和工作区改动保留，可重试继续。',
    retryable: true,
  },
  ACP_TURN_INCOMPLETE: {
    code: 'ACP_TURN_INCOMPLETE',
    message: 'Agent 回合提前结束，本轮未完成。已有对话和工作区改动保留，可重试继续。',
    retryable: true,
  },
} as const;
export type TurnFailure = (typeof turnFailures)[keyof typeof turnFailures];
export class AcpTurnFailure extends Error {
  readonly failure: TurnFailure;
  constructor(code: keyof typeof turnFailures) {
    super(turnFailures[code].message);
    this.name = 'AcpTurnFailure';
    this.failure = turnFailures[code];
  }
}

/** The pinned adapter returns this error as ordinary text with stopReason=end_turn.
 * Match the entire observed sentinel, not words inside a normal answer or tool output.
 * This is adapter compatibility, not a general semantic judgement of task success.
 */
export function nativeTurnFailure(
  agentInfo: { name: string; version: string } | null,
  output: string,
): TurnFailure | undefined {
  if (isAntigravityAgent(agentInfo) && output.trim() === 'Internal error encountered.')
    return turnFailures.AGENT_UPSTREAM_INTERNAL;
  return undefined;
}
