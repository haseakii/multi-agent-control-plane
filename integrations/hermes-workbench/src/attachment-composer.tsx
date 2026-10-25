import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Paperclip, X, RotateCcw } from 'lucide-react';
import { GooseComposer } from '@/components/chat/goose-composer';
import { composerDrafts } from './composer-drafts';
import { InputAttachment, attachmentUrl, type InputAttachmentData } from './input-attachments';
import s from './attachment-composer.module.css';
type Item = {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'error';
  file?: File;
  value?: InputAttachmentData;
  error?: string;
};
const draftListeners = new Map<string, Set<() => void>>();
type Props = Omit<ComponentProps<typeof GooseComposer>, 'onSend'> & {
  attachmentKey: string;
  initialAttachments?: InputAttachmentData[];
  onSend: (value: { text: string; attachments: InputAttachmentData[] }) => Promise<void>;
};
export function AttachmentComposer({
  attachmentKey,
  initialAttachments = [],
  onSend,
  onDraftChange,
  loading,
  initial,
  ...props
}: Props) {
  const storageKey = attachmentKey + '-attachments';
  const [items, setItems] = useState<Item[]>(() => {
    try {
      const raw = composerDrafts.read(storageKey).text;
      return (
        raw ? InputAttachment.array().max(10).parse(JSON.parse(raw)) : initialAttachments
      ).map((value) => ({
        key: value.id,
        name: value.name,
        size: value.sizeBytes,
        state: 'ready',
        value,
      }));
    } catch {
      return [];
    }
  });
  const [error, setError] = useState(''),
    [text, setText] = useState(initial ?? ''),
    [onlySending, setOnlySending] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    current = useRef(items),
    aborters = useRef(new Map<string, AbortController>());
  current.current = items;
  useEffect(() => {
    alive.current = true;
    const clear = () => {
      setItems([]);
      setText('');
    };
    const listeners = draftListeners.get(storageKey) ?? new Set<() => void>();
    listeners.add(clear);
    draftListeners.set(storageKey, listeners);
    return () => {
      alive.current = false;
      listeners.delete(clear);
      if (!listeners.size) draftListeners.delete(storageKey);
      for (const controller of aborters.current.values()) controller.abort();
    };
  }, [storageKey]);
  const commit = (update: (value: Item[]) => Item[]) =>
    setItems((previous) => {
      const next = update(previous);
      composerDrafts.write(
        storageKey,
        JSON.stringify(next.flatMap((i) => (i.value ? [i.value] : []))),
      );
      current.current = next;
      return next;
    });
  async function upload(item: Item) {
    if (!item.file) return;
    const controller = new AbortController();
    aborters.current.set(item.key, controller);
    try {
      const url =
        '/api/input-attachments?' +
        new URLSearchParams({
          name: item.file.name,
          mimeType: item.file.type || 'application/octet-stream',
        });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: item.file,
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(typeof body.error === 'string' ? body.error : '上传未完成，请重试。');
      const value = InputAttachment.parse(body);
      if (alive.current && !controller.signal.aborted)
        commit((list) =>
          list.map((i) =>
            i.key === item.key
              ? { ...i, value, state: 'ready', file: undefined, error: undefined }
              : i,
          ),
        );
    } catch (cause) {
      if (alive.current && !controller.signal.aborted)
        commit((list) =>
          list.map((i) =>
            i.key === item.key
              ? {
                  ...i,
                  state: 'error',
                  error: cause instanceof Error ? cause.message : '上传失败，请重试。',
                }
              : i,
          ),
        );
    } finally {
      aborters.current.delete(item.key);
    }
  }
  function add(files: File[]) {
    if (loading || onlySending) return;
    setError('');
    if (current.current.length + files.length > 10) {
      setError('每条消息最多 10 个附件，请分批选择。');
      return;
    }
    const next = files.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      file,
      state: (file.size < 1 || file.size > 20 * 1024 * 1024
        ? 'error'
        : 'uploading') as Item['state'],
      ...(file.size < 1 || file.size > 20 * 1024 * 1024
        ? { error: '文件须为 1 字节至 20 MB。' }
        : {}),
    }));
    commit((list) => [...list, ...next]);
    for (const item of next) if (item.state === 'uploading') void upload(item);
  }
  async function send(value: string) {
    if (current.current.some((i) => i.state !== 'ready'))
      throw Error('请等待附件上传完成，或移除失败的附件后发送。');
    const attachments = current.current.flatMap((i) => (i.value ? [i.value] : []));
    if (attachments.reduce((sum, a) => sum + a.sizeBytes, 0) > 40 * 1024 * 1024)
      throw Error('每条消息的附件总大小不能超过 40 MB。');
    await onSend({ text: value, attachments });
    composerDrafts.clear(storageKey);
    for (const clear of draftListeners.get(storageKey) ?? []) clear();
  }
  return (
    <div
      className={s.wrapper}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          add(Array.from(event.dataTransfer.files));
        }
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          add(Array.from(event.clipboardData.files));
        }
      }}
    >
      {!!items.length && (
        <ul className={s.tray} aria-label="待发送附件">
          {items.map((item) => (
            <li key={item.key} data-state={item.state}>
              {item.value?.image ? (
                <img src={attachmentUrl(item.value.id)} alt={item.name} />
              ) : (
                <Paperclip size={20} />
              )}
              <div>
                <strong title={item.name}>{item.name}</strong>
                <small>
                  {(item.size / 1024).toFixed(1)} KB ·{' '}
                  {item.state === 'uploading'
                    ? '正在上传…'
                    : item.state === 'error'
                      ? item.error
                      : '已就绪'}
                </small>
              </div>
              {item.state === 'error' && item.file && (
                <button
                  type="button"
                  aria-label={`重试上传 ${item.name}`}
                  onClick={() => {
                    commit((list) =>
                      list.map((i) =>
                        i.key === item.key ? { ...i, state: 'uploading', error: undefined } : i,
                      ),
                    );
                    void upload(item);
                  }}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                type="button"
                disabled={!!loading || onlySending}
                aria-label={`移除附件 ${item.name}`}
                onClick={() => {
                  aborters.current.get(item.key)?.abort();
                  commit((list) => list.filter((i) => i.key !== item.key));
                  if (item.value)
                    void fetch('/api/input-attachments/' + item.value.id, {
                      method: 'DELETE',
                    }).catch(() => undefined);
                }}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <GooseComposer
        {...props}
        plainTextOnly
        initial={initial}
        loading={loading || onlySending}
        onDraftChange={(value) => {
          setText(value);
          onDraftChange?.(value);
        }}
        onSend={async (value) => send(value.text)}
      />
      <div className={s.actions}>
        <input
          ref={input}
          type="file"
          multiple
          aria-label="选择文件或图片"
          hidden
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={!!loading || onlySending || items.length >= 10}
          onClick={() => input.current?.click()}
        >
          <Paperclip size={15} />
          添加文件 / 图片
        </button>
        <small>可拖入文件或粘贴图片 · 每个 20 MB，最多 10 个</small>
        {!!items.length && !text.trim() && (
          <button
            type="button"
            disabled={!!loading || onlySending || items.some((i) => i.state !== 'ready')}
            onClick={() => {
              setOnlySending(true);
              setError('');
              void send('请查看附件。')
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : '发送未确认，附件仍保留。'),
                )
                .finally(() => {
                  if (alive.current) setOnlySending(false);
                });
            }}
          >
            发送附件
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </div>
  );
}
