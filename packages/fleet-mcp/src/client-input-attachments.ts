import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  INPUT_ATTACHMENT_MAX_BYTES,
  INPUT_ATTACHMENT_TOTAL_BYTES,
  InputAttachmentIdsSchema,
  InputAttachmentSchema,
} from '@control-plane/core';
import { ClientMcpSubmitSchema, ClientMcpContinueSchema } from './client-contract.js';

export async function prepareClientAttachments(
  toolName: string,
  raw: unknown,
  upload: (query: URLSearchParams, bytes: Uint8Array) => Promise<unknown>,
) {
  if (toolName !== 'collaboration_submit_task' && toolName !== 'collaboration_continue_task')
    return raw;
  const input =
    toolName === 'collaboration_submit_task'
      ? ClientMcpSubmitSchema.parse(raw)
      : ClientMcpContinueSchema.parse(raw);
  const { attachments, ...request } = input;
  if (!attachments?.length) return request;
  if (attachments.length + (request.attachmentIds?.length ?? 0) > 10)
    throw Error('Each message supports at most 10 attachments.');
  const files: Array<{ name: string; mimeType: string; bytes: Uint8Array; sha256: string }> = [];
  let total = 0;
  // Read all selected files before uploading any. Never recurse or discover other files.
  for (const source of attachments) {
    if (
      !isAbsolute(source.path) ||
      /^[\\/]{2}/.test(source.path) ||
      (process.platform === 'win32' &&
        (!/^[a-z]:[\\/]/i.test(source.path) || /:/.test(source.path.slice(2))))
    )
      throw Error(
        'Attachments require ordinary absolute local file paths; network and device paths are not supported.',
      );
    const target = resolve(source.path),
      actual = await realpath(target),
      stat = await lstat(target);
    const normalize = (value: string) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    if (!stat.isFile() || stat.isSymbolicLink() || normalize(target) !== normalize(actual))
      throw Error('Attachment must be a regular file, not a directory or symbolic link.');
    if (stat.size < 1 || stat.size > INPUT_ATTACHMENT_MAX_BYTES)
      throw Error('Each attachment must be between 1 byte and 20 MB.');
    total += stat.size;
    if (total > INPUT_ATTACHMENT_TOTAL_BYTES)
      throw Error('Attachments exceed the 40 MB message limit.');
    const handle = await open(target, 'r');
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size !== stat.size
      )
        throw Error('Attachment changed while opening; select it again.');
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length !== stat.size) throw Error('Attachment changed while reading; select it again.');
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
    files.push({
      name: InputAttachmentSchema.shape.name.parse(source.name ?? basename(target)),
      mimeType: source.mimeType ?? 'application/octet-stream',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const ids = [...(request.attachmentIds ?? [])];
  for (const [slot, file] of files.entries()) {
    const query = new URLSearchParams({
      toolName,
      idempotencyKey: input.idempotencyKey,
      slot: String(slot),
      name: file.name,
      mimeType: file.mimeType,
      sha256: file.sha256,
      ...('projectId' in input ? { projectId: input.projectId } : { taskId: input.taskId }),
    });
    const metadata = InputAttachmentSchema.parse(await upload(query, file.bytes));
    if (
      metadata.sha256 !== file.sha256 ||
      metadata.sizeBytes !== file.bytes.length ||
      metadata.name !== file.name
    )
      throw Error('Uploaded attachment verification failed; task was not sent.');
    ids.push(metadata.id);
  }
  return { ...request, attachmentIds: InputAttachmentIdsSchema.parse(ids) };
}
