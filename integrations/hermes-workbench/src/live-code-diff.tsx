import { useMemo, useRef, useState } from 'react';
import { compareLiveText } from './live-text-diff';
import s from './workspace-review.module.css';

export function LiveCodeDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => compareLiveText(before, after), [before, after]);
  const [full, setFull] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(0);
  const content = useRef<HTMLPreElement>(null);
  const index =
    diff.kind === 'ready' ? Math.min(selectedGroup, Math.max(0, diff.groups.length - 1)) : 0;
  const group = diff.kind === 'ready' ? diff.groups[index] : undefined;
  const expanded = full || diff.kind === 'limited';
  function navigate(next: number) {
    setSelectedGroup(next);
    content.current?.focus({ preventScroll: true });
    content.current?.scrollIntoView({ block: 'nearest' });
    if (content.current) content.current.scrollTop = 0;
  }
  return (
    <div>
      <div className={s.actions}>
        <button
          type="button"
          disabled={diff.kind === 'limited'}
          aria-pressed={!expanded}
          onClick={() => setFull(false)}
        >
          只看改动
        </button>
        <button type="button" aria-pressed={expanded} onClick={() => setFull(true)}>
          完整内容对照
        </button>
      </div>
      {diff.kind === 'limited' ? (
        <p className={s.note}>文件差异较大，已显示完整内容对照，避免计算阻塞页面。</p>
      ) : (
        <p className={s.note} role="status">
          {diff.groups.length
            ? `${diff.groups.length} 处改动 · 新增 ${diff.additions} 行 · 删除 ${diff.deletions} 行。每处保留前后 3 行。`
            : '当前内容与项目基线一致（忽略 CRLF/LF 换行差异）。'}
        </p>
      )}
      {!expanded && group && (
        <>
          <div className={s.actions} aria-label="定位当前文件改动">
            <button type="button" disabled={index === 0} onClick={() => navigate(index - 1)}>
              上一处改动
            </button>
            <span>
              第 {index + 1} / {diff.kind === 'ready' ? diff.groups.length : 0} 处
            </span>
            <button
              type="button"
              disabled={diff.kind !== 'ready' || index + 1 >= diff.groups.length}
              onClick={() => navigate(index + 1)}
            >
              下一处改动
            </button>
          </div>
          <pre
            ref={content}
            tabIndex={0}
            className={s.diff}
            data-wrap="true"
            aria-label="当前文件改动行"
          >
            {group.map((line, i) => (
              <span key={i}>
                <span className={s.diffLine} data-kind={line.kind}>
                  <span
                    className={s.lineNumber}
                    aria-label={line.before ? `原第 ${line.before} 行` : undefined}
                    data-line-number={line.before ?? ''}
                  />
                  <span
                    className={s.lineNumber}
                    aria-label={line.after ? `现第 ${line.after} 行` : undefined}
                    data-line-number={line.after ?? ''}
                  />
                  <code>
                    {line.text}
                    {'\n'}
                  </code>
                </span>
                {line.noNewline && (
                  <span className={s.diffLine} data-kind="hunk">
                    <span />
                    <span />
                    <code>\ 文件末尾无换行{'\n'}</code>
                  </span>
                )}
              </span>
            ))}
          </pre>
        </>
      )}
      {expanded && (
        <div className={s.liveColumns}>
          <div>
            <strong>项目基线</strong>
            <pre tabIndex={0} aria-label="基线文件内容">
              {before || '（空文件或原先不存在）'}
            </pre>
          </div>
          <div>
            <strong>当前内容</strong>
            <pre tabIndex={0} aria-label="当前文件内容">
              {after || '（空文件或已删除）'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
