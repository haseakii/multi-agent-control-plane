// Opt-in, bounded diagnostics for ACP permission compatibility. Never archives wire data.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { redactPermissionValue } from '../../packages/acp-runtime/dist/index.js';

export function observePermissions(readable, filename, agentId) {
  const decoder = new TextDecoder();
  let buffered = '';
  let dropping = false;
  let count = 0;
  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (count >= 8) return;
        buffered += decoder.decode(chunk, { stream: true });
        for (; count < 8; ) {
          const end = buffered.indexOf('\n');
          if (end < 0) break;
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (dropping) {
            dropping = false;
            continue;
          }
          if (line.length > 256 * 1024) continue;
          try {
            const message = JSON.parse(line);
            if (message.method !== 'session/request_permission') continue;
            const call = message.params?.toolCall;
            if (!call || typeof call !== 'object') continue;
            const fields = [
              'title',
              'name',
              'kind',
              'status',
              'rawInput',
              'content',
              'locations',
              '_meta',
              'rawOutput',
            ];
            const safe = redactPermissionValue(call);
            const diagnostics = {
              at: new Date().toISOString(),
              agentId,
              callHash: createHash('sha256').update(String(call.toolCallId)).digest('hex'),
              title: safe.value.title ?? null,
              name: safe.value.name ?? null,
              kind: safe.value.kind ?? null,
              status: safe.value.status ?? null,
              rawInput: safe.value.rawInput ?? null,
              redacted: safe.redacted,
              truncated: safe.truncated,
              fields: fields.filter((field) => Object.hasOwn(call, field)),
              redactedFields: fields.filter(
                (field) =>
                  Object.hasOwn(call, field) &&
                  redactPermissionValue({ [field]: call[field] }).redacted,
              ),
              // Inspect metadata structure through the same bounded secret scrubber;
              // the live permission collector still treats nonempty metadata as opaque.
              metadata: redactPermissionValue(call._meta ?? null),
              metaShape: !Object.hasOwn(call, '_meta')
                ? 'absent'
                : call._meta === null
                  ? 'null'
                  : Array.isArray(call._meta)
                    ? `array:${call._meta.length}`
                    : typeof call._meta === 'object'
                      ? `object:${Object.keys(call._meta).length}`
                      : typeof call._meta,
            };
            fs.appendFileSync(filename, JSON.stringify(diagnostics) + '\n');
            count++;
          } catch {
            /* Diagnostics never changes protocol delivery or approval. */
          }
        }
        if (buffered.length > 256 * 1024) {
          buffered = '';
          dropping = true;
        }
      },
    }),
  );
}
