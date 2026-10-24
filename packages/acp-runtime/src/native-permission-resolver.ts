import { posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactPermissionValue, type PermissionSemantics } from './permission-review.js';

const RequestSchema = z
  .object({
    sessionId: z.string().min(1),
    agentInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
    toolCall: z.record(z.string(), z.unknown()),
  })
  .strict();
const CommandSchema = z
  .object({
    CommandLine: z.string().min(1).max(768),
    Cwd: z
      .string()
      .min(1)
      .max(768)
      .refine((path) => win32.isAbsolute(path) || posix.isAbsolute(path)),
    WaitMsBeforeAsync: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Describe the observed native command envelope of the pinned ACP adapter.
 * This is review information only, never permission to run the command and
 * never a claim that its effects are confined to Cwd. Unknown formats fail closed.
 */
export function resolveNativeCommandPermission(request: {
  sessionId: string;
  agentInfo: { name: string; version: string } | null;
  toolCall: Readonly<Record<string, unknown>>;
}): PermissionSemantics | null {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { agentInfo, toolCall } = parsed.data;
  if (agentInfo?.name !== 'antigravity-acp' || agentInfo.version !== '1.4.1') return null;
  if (toolCall.kind !== 'execute' || Object.hasOwn(toolCall, '_meta')) return null;
  if (Object.hasOwn(toolCall, 'name') && toolCall.name !== 'run_command') return null;
  const input = CommandSchema.safeParse(toolCall.rawInput);
  if (!input.success) return null;
  return {
    tool: 'run_command',
    action: 'process.execute',
    target: input.data.Cwd,
    parameters: {
      command: input.data.CommandLine,
      workingDirectory: input.data.Cwd,
      identitySource: 'antigravity-acp@1.4.1:native-command-envelope',
      confinement: 'unavailable',
    },
  };
}

const EditSchema = z
  .object({
    TargetFile: CommandSchema.shape.Cwd,
    TargetContent: z.string().min(1).max(1_048_576),
    ReplacementContent: z.string().max(1_048_576),
    StartLine: z.number().int().positive(),
    EndLine: z.number().int().positive(),
    AllowMultiple: z.boolean(),
    Description: z.string().max(768),
    Instruction: z.string().max(768),
  })
  .strict()
  .refine((input) => input.EndLine >= input.StartLine);
const ModifyMetadata = z.object({ kind: z.literal('modify') }).strict();
const DiffSchema = z
  .object({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
    _meta: ModifyMetadata,
  })
  .strict();
type NativeRequest = Parameters<typeof resolveNativeCommandPermission>[0];

function nativeEdit(request: NativeRequest) {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { agentInfo, toolCall } = parsed.data;
  if (
    agentInfo?.name !== 'antigravity-acp' ||
    agentInfo.version !== '1.4.1' ||
    toolCall.kind !== 'edit' ||
    Object.hasOwn(toolCall, '_meta') ||
    (Object.hasOwn(toolCall, 'name') && toolCall.name !== 'edit_file')
  )
    return null;
  const input = EditSchema.safeParse(toolCall.rawInput);
  const diffs = z.array(DiffSchema).length(1).safeParse(toolCall.content);
  if (!input.success || !diffs.success) return null;
  const diff = diffs.data[0]!;
  if (
    diff.path !== input.data.TargetFile ||
    diff.oldText !== input.data.TargetContent ||
    diff.newText !== input.data.ReplacementContent
  )
    return null;
  return input.data;
}

/** Validate the whole descriptor before compacting code, never authority fields.
 * Digests bind the audit to exact bytes. Code is reviewed separately before merge.
 * Unknown shapes and sensitive text retain ordinary fail-closed review.
 */
export function summarizeNativeEditPermission(
  request: NativeRequest,
): Record<string, unknown> | null {
  const input = nativeEdit(request);
  if (!input) return null;
  const bodies = [input.TargetContent, input.ReplacementContent];
  if (bodies.every((text) => Buffer.byteLength(text) <= 768)) return null;
  // Force a whole-text scan even for a JSON source file: the generic JSON
  // traversal budget must not skip a sensitive value near the end of the file.
  if (bodies.some((text) => redactPermissionValue('file-content:\n' + text).redacted)) return null;
  const digest = (text: string) =>
    `[file-content bytes=${Buffer.byteLength(text)} sha256=${createHash('sha256').update(text).digest('hex')}]`;
  const oldText = digest(input.TargetContent),
    newText = digest(input.ReplacementContent);
  return {
    ...request.toolCall,
    rawInput: { ...input, TargetContent: oldText, ReplacementContent: newText },
    content: [
      { type: 'diff', path: input.TargetFile, oldText, newText, _meta: { kind: 'modify' } },
    ],
  };
}

/** Only the observed, exact native edit descriptor is inspectable; it grants no authority. */
export function validateNativeEditMetadata(
  request: NativeRequest & { metadata: unknown },
): boolean {
  return (
    !!nativeEdit({
      sessionId: request.sessionId,
      agentInfo: request.agentInfo,
      toolCall: request.toolCall,
    }) && ModifyMetadata.safeParse(request.metadata).success
  );
}

export function resolveNativeToolPermission(request: NativeRequest): PermissionSemantics | null {
  const command = resolveNativeCommandPermission(request);
  if (command) return command;
  const input = nativeEdit(request);
  if (!input) return null;
  return {
    tool: 'edit_file',
    action: 'file.write',
    target: input.TargetFile,
    parameters: {
      identitySource: 'antigravity-acp@1.4.1:native-edit-envelope',
      fileOperation: 'write',
      confinement: 'unavailable',
    },
  };
}
