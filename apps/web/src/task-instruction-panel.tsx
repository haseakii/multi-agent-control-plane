import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, HttpError } from './http';
import {
  InstructionSubmission,
  type InstructionView,
  type InstructionSnapshot,
} from './instruction-submission';

const reasons: Record<InstructionSnapshot['reason'], string> = {
  active: '保存在当前任务中，在安全的下一轮顺序送达。',
  task_ended: '任务已结束，可查看补充历史。',
  not_executing: '任务未在执行；补充不会自动恢复任务。',
  finishing: '任务正在保存结果，已停止接受新补充。',
  stopping: '服务正在停止，暂不接受新补充。',
  owner_changed: '执行尝试已变化，请等待最新状态。',
};
export function InstructionHistory({ instructions }: { instructions: InstructionView[] }) {
  return (
    <ol className="instruction-history">
      {instructions.map((row) => (
        <li key={row.id}>
          <div>
            <strong>本机操作台补充</strong>
            <span className="badge">
              {row.state === 'queued'
                ? '已保存 · 等待下一轮'
                : row.state === 'claimed'
                  ? '已交给当前轮'
                  : '包含该补充的轮次已结束'}
            </span>
          </div>
          <p className="message-content">{row.content}</p>
        </li>
      ))}
    </ol>
  );
}
export function TaskInstructionPanel({ taskId }: { taskId: string }) {
  const [snapshot, setSnapshot] = useState<InstructionSnapshot | null>(null);
  const [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0);
  const submission = useRef(new InstructionSubmission(() => crypto.randomUUID()));
  const path = '/api/tasks/' + encodeURIComponent(taskId) + '/instructions';
  async function refresh() {
    const version = ++generation.current;
    try {
      const next = await api<InstructionSnapshot>(path);
      if (mounted.current && version === generation.current) {
        setSnapshot(next);
        setLoadError('');
      }
    } catch {
      if (mounted.current && version === generation.current) {
        setSnapshot(null);
        setLoadError('补充状态刷新失败，暂不可提交新内容。');
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await refresh();
      if (active && mounted.current) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!uncertain && !snapshot?.canSubmit) return;
    const request = submission.current.begin(draft);
    if (!request) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const result = await api<{ instruction: InstructionView; reused: boolean }>(path, {
        method: 'POST',
        body: JSON.stringify(request),
      });
      submission.current.finish('confirmed');
      if (!mounted.current) return;
      setDraft('');
      setUncertain(false);
      setNotice(
        result.reused ? '已确认之前保存的补充，没有重复提交。' : '补充已保存，接收状态见上方记录。',
      );
      await refresh();
    } catch (cause) {
      const known = cause instanceof HttpError && cause.status >= 400 && cause.status < 500;
      submission.current.finish(known ? 'rejected' : 'unknown');
      if (mounted.current) {
        setUncertain(!known);
        setError(
          known
            ? `未保存：${cause.message}`
            : '保存结果尚未确认。请重试确认；将复用原请求标识，避免重复保存。',
        );
        if (known) void refresh();
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="task-instructions" aria-label="任务补充" aria-busy={busy}>
      <h2>任务补充</h2>
      <p className="section-note">
        补充仅保存给当前任务。审批仍需单独处理；轮次结束不代表要求已理解或操作已成功。
      </p>
      {snapshot?.instructions.length ? (
        <InstructionHistory instructions={snapshot.instructions} />
      ) : (
        <p className="empty">暂无任务补充。</p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="task-instruction-content">补充当前任务的要求</label>
        <textarea
          id="task-instruction-content"
          value={draft}
          rows={3}
          maxLength={4000}
          disabled={busy || uncertain || !snapshot?.canSubmit}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：请在报告中补充验证步骤。请勿输入凭据。"
        />
        <p className="section-note">
          {snapshot ? reasons[snapshot.reason] : '正在确认任务状态…'} {draft.length}/4000
        </p>
        <button
          type="submit"
          disabled={busy || (!uncertain && !snapshot?.canSubmit) || !draft.trim()}
        >
          {busy ? '正在保存…' : uncertain ? '重试确认' : '保存任务补充'}
        </button>
      </form>
      {notice ? <p role="status">{notice}</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
