import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INPUT_ATTACHMENT_MAX_BYTES, InputAttachmentIdSchema } from '@control-plane/core';
import type { InputAttachmentService } from './input-attachments.js';
export function registerInputAttachmentRoutes(
  app: FastifyInstance,
  service: InputAttachmentService,
) {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: INPUT_ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/api/input-attachments',
    { bodyLimit: INPUT_ATTACHMENT_MAX_BYTES },
    async (request, reply) => {
      try {
        const query = z
          .object({ name: z.string().min(1).max(255), mimeType: z.string().max(128).optional() })
          .strict()
          .parse(request.query);
        if (!Buffer.isBuffer(request.body))
          return reply.code(400).send({ error: '请发送文件内容。' });
        return service.upload(
          query.name,
          query.mimeType ?? 'application/octet-stream',
          request.body,
        );
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof z.ZodError
              ? '文件名称或大小无效。'
              : error instanceof Error
                ? error.message
                : '附件上传未完成，请重试。',
        });
      }
    },
  );
  app.get('/api/input-attachments/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return service.repository.get(
        InputAttachmentIdSchema.parse((request.params as { id: string }).id),
      );
    } catch {
      return reply.code(404).send({ error: '附件不存在，请重新上传。' });
    }
  });
  app.get('/api/input-attachments/:id/content', async (request, reply) => {
    try {
      const id = InputAttachmentIdSchema.parse((request.params as { id: string }).id),
        meta = service.repository.get(id),
        bytes = service.repository.read(id);
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox");
      reply.header(
        'content-disposition',
        `${meta.image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name).replaceAll("'", '%27')}`,
      );
      return reply
        .type(meta.image ? meta.mimeType : 'application/octet-stream')
        .send(Buffer.from(bytes));
    } catch {
      return reply.code(404).send({ error: '附件暂不可读，原记录仍保留。' });
    }
  });
  app.delete('/api/input-attachments/:id', async (request, reply) => {
    try {
      const removed = service.repository.removeUnbound(
        InputAttachmentIdSchema.parse((request.params as { id: string }).id),
      );
      return removed
        ? { removed: true }
        : reply.code(409).send({ error: '已发送附件随任务保留，不能作为未发送草稿删除。' });
    } catch {
      return reply.code(404).send({ error: '附件不存在。' });
    }
  });
}
