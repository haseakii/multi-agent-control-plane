import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition } from '@control-plane/core';
import { isNodeEntrypoint } from '@control-plane/runner';

export const TerminalAuthMethodSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal('terminal'),
    args: z.array(z.string().max(4096)).max(64).default([]),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).default({}),
  })
  .refine(
    (method) =>
      Object.keys(method.env).length <= 32 && Buffer.byteLength(JSON.stringify(method)) <= 12000,
  );

/** Preserve interpreter entrypoints while replacing the Agent's ordinary ACP arguments. */
export function terminalInvocationPrefix(runtime: AgentDefinition['runtime']) {
  const name = basename(runtime.command).toLowerCase();
  if (/^(?:node|python(?:3(?:\.\d+)?)?)(?:\.exe)?$/.test(name)) {
    if (
      !runtime.args[0] ||
      !isAbsolute(runtime.args[0]) ||
      !(/^node(?:\.exe)?$/.test(name)
        ? isNodeEntrypoint(runtime.args[0])
        : /\.py$/i.test(runtime.args[0]))
    )
      return undefined;
    return [runtime.args[0]];
  }
  return [];
}
export type TerminalAuthenticationRequest = {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
};
export type TerminalAuthenticationHandler = (
  request: TerminalAuthenticationRequest,
) => Promise<void>;
