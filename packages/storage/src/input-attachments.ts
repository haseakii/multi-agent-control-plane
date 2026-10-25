import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  InputAttachmentSchema,
  InputAttachmentIdsSchema,
  InputAttachmentIdSchema,
  INPUT_ATTACHMENT_TOTAL_BYTES,
  type InputAttachment,
} from '@control-plane/core';
export interface InputAttachmentRepository {
  put(metadata: InputAttachment, content: Uint8Array): InputAttachment;
  get(id: string): InputAttachment;
  find(id: string): InputAttachment | undefined;
  read(id: string): Uint8Array;
  removeUnbound(id: string): boolean;
  bind(taskId: string, ownerId: string, ids: string[], replace?: boolean): void;
  forOwner(ownerId: string): InputAttachment[];
  forTask(taskId: string): InputAttachment[];
  messages(): Array<{ taskId: string; ownerId: string; attachments: InputAttachment[] }>;
}
export class SqliteInputAttachmentRepository implements InputAttachmentRepository {
  constructor(private readonly sqlite: Database.Database) {}
  put(raw: InputAttachment, content: Uint8Array) {
    const value = InputAttachmentSchema.parse(raw);
    if (
      value.sizeBytes !== content.byteLength ||
      value.sha256 !== createHash('sha256').update(content).digest('hex')
    )
      throw Error('Attachment content does not match its metadata.');
    return this.sqlite
      .transaction(() => {
        const total = this.sqlite
          .prepare('SELECT coalesce(sum(length(content)),0) AS bytes FROM input_attachments')
          .get() as { bytes: number };
        if (total.bytes + content.byteLength > 1024 * 1024 * 1024)
          throw Error('附件存储已满，请先移除未发送的附件。');
        this.sqlite
          .prepare('INSERT INTO input_attachments(id,payload,content) VALUES(?,?,?)')
          .run(value.id, JSON.stringify(value), Buffer.from(content));
        return value;
      })
      .immediate();
  }
  find(rawId: string) {
    const id = InputAttachmentIdSchema.parse(rawId);
    const row = this.sqlite.prepare('SELECT payload FROM input_attachments WHERE id=?').get(id) as
      | { payload: string }
      | undefined;
    if (!row) return undefined;
    const value = InputAttachmentSchema.parse(JSON.parse(row.payload));
    if (value.id !== id) throw Error('Attachment identity mismatch.');
    return value;
  }
  get(id: string) {
    const value = this.find(id);
    if (!value) throw Error('附件不存在，请重新上传。');
    return value;
  }
  read(id: string) {
    const metadata = this.get(id);
    const row = this.sqlite.prepare('SELECT content FROM input_attachments WHERE id=?').get(id) as {
      content: Buffer;
    };
    if (
      row.content.length !== metadata.sizeBytes ||
      createHash('sha256').update(row.content).digest('hex') !== metadata.sha256
    )
      throw Error('附件完整性校验失败。');
    return new Uint8Array(row.content);
  }
  removeUnbound(id: string) {
    this.get(id);
    const rows = this.sqlite.prepare('SELECT ids_json FROM input_attachment_messages').all() as {
      ids_json: string;
    }[];
    if (rows.some((row) => InputAttachmentIdsSchema.parse(JSON.parse(row.ids_json)).includes(id)))
      return false;
    return this.sqlite.prepare('DELETE FROM input_attachments WHERE id=?').run(id).changes === 1;
  }
  bind(taskId: string, ownerId: string, rawIds: string[], replace = false) {
    const ids = InputAttachmentIdsSchema.parse(rawIds);
    const values = ids.map((id) => this.get(id));
    if (values.reduce((sum, value) => sum + value.sizeBytes, 0) > INPUT_ATTACHMENT_TOTAL_BYTES)
      throw Error('每条消息的附件总大小不能超过 40 MB。');
    const existing = this.sqlite
      .prepare('SELECT task_id,ids_json FROM input_attachment_messages WHERE owner_id=?')
      .get(ownerId) as { task_id: string; ids_json: string } | undefined;
    if (
      existing &&
      (existing.task_id !== taskId || (!replace && JSON.stringify(ids) !== existing.ids_json))
    )
      throw Error('本次发送的附件已冻结，请核对原发送记录。');
    this.sqlite
      .prepare(
        'INSERT INTO input_attachment_messages(owner_id,task_id,ids_json) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET ids_json=excluded.ids_json',
      )
      .run(ownerId, taskId, JSON.stringify(ids));
  }
  forOwner(ownerId: string) {
    const row = this.sqlite
      .prepare('SELECT ids_json FROM input_attachment_messages WHERE owner_id=?')
      .get(ownerId) as { ids_json: string } | undefined;
    return row
      ? InputAttachmentIdsSchema.parse(JSON.parse(row.ids_json)).map((id) => this.get(id))
      : [];
  }
  forTask(taskId: string) {
    const rows = this.sqlite
      .prepare('SELECT ids_json FROM input_attachment_messages WHERE task_id=? ORDER BY rowid')
      .all(taskId) as { ids_json: string }[];
    return [
      ...new Set(rows.flatMap((row) => InputAttachmentIdsSchema.parse(JSON.parse(row.ids_json)))),
    ].map((id) => this.get(id));
  }
  messages() {
    return (
      this.sqlite
        .prepare('SELECT owner_id,task_id,ids_json FROM input_attachment_messages ORDER BY rowid')
        .all() as { owner_id: string; task_id: string; ids_json: string }[]
    ).flatMap((row) => {
      const attachments = InputAttachmentIdsSchema.parse(JSON.parse(row.ids_json)).map((id) =>
        this.get(id),
      );
      return attachments.length
        ? [{ ownerId: row.owner_id, taskId: row.task_id, attachments }]
        : [];
    });
  }
}
