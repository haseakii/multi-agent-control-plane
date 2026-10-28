import { posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactPermissionValue, type PermissionSemantics } from './permission-review.js';

export function isAntigravityAgent(
  agentInfo: { name: string; version: string } | null | undefined,
): boolean {
  if (!agentInfo) return false;
  const name = agentInfo.name.toLowerCase();
  const isName =
    name === 'antigravity-acp' ||
    name === 'antigravity' ||
    name.startsWith('antigravity-') ||
    name.includes('antigravity');
  if (!isName) return false;
  return /^1(\.\d+)+(-[\w.-]+)?$/.test(agentInfo.version);
}

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
    toolSummary: z.string().max(768).optional(),
    IsDaemon: z.boolean().optional(),
    description: z.string().max(768).optional(),
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
  if (!isAntigravityAgent(agentInfo)) return null;
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
      identitySource: `${agentInfo!.name}@${agentInfo!.version}:native-command-envelope`,
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
    toolSummary: z.string().max(768).optional(),
  })
  .strict()
  .refine((input) => input.EndLine >= input.StartLine);
const ModifyMetadata = z.object({ kind: z.literal('modify') }).strict();
const CreateMetadata = z.object({ kind: z.literal('add') }).strict();
const DiffSchema = z
  .object({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
    _meta: ModifyMetadata,
  })
  .strict();
const CreateSchema = z
  .object({
    CodeContent: z.string().max(1_048_576),
    Description: z.string().max(768),
    Overwrite: z.boolean(),
    Instruction: z.string().max(768).optional(),
    TargetFile: CommandSchema.shape.Cwd,
    toolSummary: z.string().max(768).optional(),
  })
  .strict();
const CreateDiffSchema = z
  .object({
    type: z.literal('diff'),
    path: z.string(),
    newText: z.string(),
    _meta: CreateMetadata,
  })
  .strict();
type NativeRequest = Parameters<typeof resolveNativeCommandPermission>[0];

function nativeEdit(request: NativeRequest) {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { agentInfo, toolCall } = parsed.data;
  if (
    !isAntigravityAgent(agentInfo) ||
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

function nativeCreate(request: NativeRequest) {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { agentInfo, toolCall } = parsed.data;
  if (
    !isAntigravityAgent(agentInfo) ||
    toolCall.kind !== 'edit' ||
    Object.hasOwn(toolCall, '_meta') ||
    (Object.hasOwn(toolCall, 'name') && toolCall.name !== 'create_file')
  )
    return null;
  const input = CreateSchema.safeParse(toolCall.rawInput);
  const diffs = z.array(CreateDiffSchema).length(1).safeParse(toolCall.content);
  if (!input.success || !diffs.success) return null;
  const diff = diffs.data[0]!;
  if (diff.path !== input.data.TargetFile || diff.newText !== input.data.CodeContent) return null;
  return input.data;
}

const contentDigest = (text: string) =>
  `[file-content bytes=${Buffer.byteLength(text)} sha256=${createHash('sha256').update(text).digest('hex')}]`;

/** Validate the whole descriptor before compacting code, never authority fields.
 * Digests bind the audit to exact bytes. Code is reviewed separately before merge.
 * Unknown shapes and sensitive text retain ordinary fail-closed review.
 */
export function summarizeNativeEditPermission(
  request: NativeRequest,
): Record<string, unknown> | null {
  const create = nativeCreate(request);
  if (create) {
    if (Buffer.byteLength(create.CodeContent) <= 768) return null;
    if (redactPermissionValue('file-content:\n' + create.CodeContent).redacted) return null;
    const newText = contentDigest(create.CodeContent);
    return {
      ...request.toolCall,
      rawInput: { ...create, CodeContent: newText },
      content: [{ type: 'diff', path: create.TargetFile, newText, _meta: { kind: 'add' } }],
    };
  }
  const input = nativeEdit(request);
  if (!input) return null;
  const bodies = [input.TargetContent, input.ReplacementContent];
  if (bodies.every((text) => Buffer.byteLength(text) <= 768)) return null;
  // Force a whole-text scan even for a JSON source file: the generic JSON
  // traversal budget must not skip a sensitive value near the end of the file.
  if (bodies.some((text) => redactPermissionValue('file-content:\n' + text).redacted)) return null;
  const oldText = contentDigest(input.TargetContent),
    newText = contentDigest(input.ReplacementContent);
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
  const { metadata, ...native } = request;
  if (nativeEdit(native)) return ModifyMetadata.safeParse(metadata).success;
  return !!nativeCreate(native) && CreateMetadata.safeParse(metadata).success;
}

export function resolveNativeToolPermission(request: NativeRequest): PermissionSemantics | null {
  const command = resolveNativeCommandPermission(request);
  if (command) return command;
  const create = nativeCreate(request);
  if (create)
    return {
      tool: 'create_file',
      action: 'file.write',
      target: create.TargetFile,
      parameters: {
        identitySource: `${request.agentInfo?.name ?? 'antigravity-acp'}@${request.agentInfo?.version ?? '1.4.1'}:native-create-envelope`,
        fileOperation: 'write',
        overwrite: create.Overwrite,
        confinement: 'unavailable',
      },
    };
  const input = nativeEdit(request);
  if (!input) return null;
  return {
    tool: 'edit_file',
    action: 'file.write',
    target: input.TargetFile,
    parameters: {
      identitySource: `${request.agentInfo?.name ?? 'antigravity-acp'}@${request.agentInfo?.version ?? '1.4.1'}:native-edit-envelope`,
      fileOperation: 'write',
      confinement: 'unavailable',
    },
  };
}
