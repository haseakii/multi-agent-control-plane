import { useState } from 'react';
import {
  filterReviewFiles,
  reviewFileLabels,
  reviewFileNavigation,
  type ReviewFile,
  type ReviewFileFilter,
} from './review-files';
import s from './workspace-review.module.css';

export function ReviewFilePicker({
  files,
  selectedPath,
  onSelect,
}: {
  files: ReviewFile[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ReviewFileFilter>('all');
  const visible = filterReviewFiles(files, query, status);
  const navigation = reviewFileNavigation(visible, selectedPath);
  const filtered = !!query || status !== 'all';
  return (
    <section className={s.filePicker} aria-label="查找变更文件">
      <div className={s.fileFilters}>
        <label>
          搜索文件路径
          <input
            type="search"
            value={query}
            placeholder="例如 src/、.css 或文件名"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          变更类型
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ReviewFileFilter)}
          >
            <option value="all">全部类型（{files.length}）</option>
            {Object.entries(reviewFileLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}（{files.filter((file) => file.status === value).length}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={s.note} role="status">
        显示 {visible.length} / {files.length} 个文件。筛选只影响查看，批准与合并仍针对整份快照。
      </p>
      {filtered && (
        <button
          type="button"
          onClick={() => {
            setQuery('');
            setStatus('all');
          }}
        >
          清除文件筛选
        </button>
      )}
      {selectedPath && navigation.index < 0 && filtered && (
        <p className={s.note}>当前查看的 {selectedPath} 不在筛选结果中，已打开的差异仍保留。</p>
      )}
      {!visible.length && <p className={s.note}>没有匹配的文件，请调整路径或变更类型。</p>}
      <ul className={s.files}>
        {visible.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              aria-pressed={selectedPath === file.path}
              onClick={() => onSelect(file.path)}
            >
              <code>{file.path}</code>
            </button>
            <span>
              {reviewFileLabels[file.status]} ·{' '}
              {file.additions === null || file.deletions === null
                ? '二进制文件'
                : `+${file.additions} / −${file.deletions}`}
            </span>
          </li>
        ))}
      </ul>
      {visible.length > 0 && (
        <div className={s.actions} aria-label="逐个查看文件">
          {navigation.index < 0 ? (
            <button type="button" onClick={() => onSelect(navigation.first!)}>
              查看首个结果
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!navigation.previous}
                onClick={() => onSelect(navigation.previous!)}
              >
                上一个文件
              </button>
              <span>
                第 {navigation.index + 1} / {visible.length} 个{filtered ? '匹配文件' : '文件'}
              </span>
              <button
                type="button"
                disabled={!navigation.next}
                onClick={() => onSelect(navigation.next!)}
              >
                下一个文件
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
