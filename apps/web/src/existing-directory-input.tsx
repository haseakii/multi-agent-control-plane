import { useRef, useState } from 'react';
export type ProjectDirectoryChoice =
  | { kind: 'managed' }
  | { kind: 'pending' }
  | { kind: 'existing-local'; validationId: string; confirmedPath: string };
type Preview = { validationId: string; rootPath: string; expiresAt: string; notice: string };
export function ExistingDirectoryInput({
  disabled,
  onChoice,
}: {
  disabled: boolean;
  onChoice: (value: ProjectDirectoryChoice) => void;
}) {
  const [existing, setExisting] = useState(false),
    [path, setPath] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    inFlight = useRef(false),
    input = useRef<HTMLInputElement>(null);
  const invalidate = () => {
    ++generation.current;
    setPreview(null);
    setConfirmed(false);
    setError(null);
    onChoice({ kind: 'pending' });
  };
  const validate = async () => {
    if (inFlight.current || disabled || !path) return;
    inFlight.current = true;
    const ticket = ++generation.current;
    setPending(true);
    setError(null);
    setPreview(null);
    setConfirmed(false);
    onChoice({ kind: 'pending' });
    try {
      const response = await fetch('/api/directories/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const value = (await response.json()) as Preview & { error?: string };
      if (!response.ok) throw new Error(value.error ?? 'Directory validation failed.');
      if (ticket === generation.current) setPreview(value);
    } catch (reason) {
      if (ticket === generation.current)
        setError(reason instanceof Error ? reason.message : 'Directory validation failed.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <fieldset className="directory-input" disabled={disabled || pending}>
      <label>
        Workspace source
        <select
          aria-label="Workspace source"
          value={existing ? 'existing' : 'managed'}
          onChange={(event) => {
            invalidate();
            const value = event.target.value === 'existing';
            setExisting(value);
            if (!value) onChoice({ kind: 'managed' });
          }}
        >
          <option value="managed">新建空目录</option>
          <option value="existing">关联已有目录</option>
        </select>
      </label>
      {existing ? (
        <>
          <label>
            Existing directory path
            <input
              ref={input}
              value={path}
              maxLength={4096}
              onChange={(event) => {
                setPath(event.target.value);
                invalidate();
              }}
              placeholder="本机绝对路径；不上传文件"
            />
          </label>
          <button type="button" disabled={!path} onClick={() => void validate()}>
            {pending ? '校验中…' : 'Validate directory'}
          </button>
          <small>只校验指定路径的元数据；不会扫描、复制、克隆、清理目录或启动 Agent。</small>
          {error ? (
            <p role="alert" className="inline-error">
              {error}
            </p>
          ) : null}
          {preview ? (
            <>
              <span>最终实际路径</span>
              <output aria-label="Actual directory path" className="directory-path">
                {preview.rootPath}
              </output>
              <p>{preview.notice}</p>
              <label className="directory-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                    onChoice(
                      event.target.checked
                        ? {
                            kind: 'existing-local',
                            validationId: preview.validationId,
                            confirmedPath: preview.rootPath,
                          }
                        : { kind: 'pending' },
                    );
                  }}
                />
                Confirm this actual directory
              </label>
              <button
                type="button"
                onClick={() => {
                  invalidate();
                  input.current?.focus();
                }}
              >
                Cancel directory confirmation
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}

export function DirectoryExecutionNotice({ rootPath }: { rootPath: string }) {
  return (
    <section className="directory-execution-notice">
      <strong>本次任务的已有工作区</strong>
      <code className="directory-path">{rootPath}</code>
      <p>
        确认后 Agent 可按本次目标读取或修改此目录。关联本身不扩大 MCP / filesystem 权限；LocalRunner
        不是 OS 沙箱，也不保证拦截 Agent 自带工具。备份不含此目录源码，恢复后需重新核对路径。
      </p>
    </section>
  );
}
