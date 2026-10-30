import { useState } from 'react';
import type { Artifact } from './view-model';

function renderDiffLine(line: string, index: number) {
  let lineClass = 'diff-line';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) {
    lineClass += ' diff-header';
  } else if (line.startsWith('@@')) {
    lineClass += ' diff-hunk';
  } else if (line.startsWith('+')) {
    lineClass += ' diff-add';
  } else if (line.startsWith('-')) {
    lineClass += ' diff-remove';
  }
  return (
    <div key={index} className={lineClass}>
      <span className="diff-line-number">{index + 1}</span>
      <span className="diff-line-content">{line}</span>
    </div>
  );
}

export function ArtifactContentViewer({
  artifact,
  content,
}: {
  artifact: Artifact;
  content: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isDiff =
    artifact.kind === 'diff' ||
    artifact.id.endsWith('.diff') ||
    artifact.id.endsWith('.patch') ||
    content.startsWith('diff --git') ||
    content.startsWith('--- a/');

  const lines = content.split('\n');

  return (
    <div className="artifact-viewer">
      <div className="artifact-toolbar">
        <span className="artifact-meta">
          {lines.length} 行 · {artifact.mimeType}
        </span>
        <button
          type="button"
          className="copy-button"
          onClick={() => void handleCopy()}
          aria-label="复制产物内容"
        >
          {copied ? '已复制 ✓' : '复制内容'}
        </button>
      </div>
      <div className="artifact-scroll-pane">
        {isDiff ? (
          <div className="diff-viewer">{lines.map((line, idx) => renderDiffLine(line, idx))}</div>
        ) : (
          <pre className="result-content">{content}</pre>
        )}
      </div>
    </div>
  );
}
