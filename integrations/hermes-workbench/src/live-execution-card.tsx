import { useState, useEffect, useMemo } from 'react';
import { toolPresentation } from './activity-presentation';
import { taskFamily, type SnapshotData, type TaskData } from './adapter';
import { agentActivity } from './agent-activity';
import s from './live-execution-card.module.css';

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    ready: '就绪',
    waiting: '等待中',
    waiting_children: '等待协作',
    running: '执行中',
    blocked: '已暂停',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
  };
  return labels[state] ?? state;
}

export function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '0秒';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
}

export function formatTimer(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LiveExecutionCard({
  snapshot,
  root,
  rounds,
  busy,
  onInspectProcess,
}: {
  snapshot: SnapshotData;
  root: TaskData;
  rounds: TaskData[];
  busy: boolean;
  onInspectProcess: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [busy]);

  const family = useMemo(() => taskFamily(snapshot, root), [snapshot, root]);
  const taskIds = useMemo(() => family.map((t) => t.id), [family]);
  const attempts = useMemo(
    () => snapshot.executionAttempts.filter((a) => taskIds.includes(a.taskId)),
    [snapshot.executionAttempts, taskIds],
  );
  const activity = useMemo(
    () => agentActivity(snapshot.timeline, taskIds),
    [snapshot.timeline, taskIds],
  );

  const collaborators = useMemo(() => {
    const set = new Set<string>();
    for (const t of family) if (t.ownerAgentId) set.add(t.ownerAgentId);
    for (const a of attempts) {
      const agentId = snapshot.assignments.find((item) => item.id === a.assignmentId)?.agentId;
      if (agentId) set.add(agentId);
    }
    return set;
  }, [family, attempts, snapshot.assignments]);

  const collaboratorsCount = Math.max(1, collaborators.size);

  const activeAttempt =
    attempts.find((a) => ['queued', 'running', 'waiting'].includes(a.state)) ?? attempts.at(-1);
  const activeAgentId =
    (activeAttempt
      ? snapshot.assignments.find((item) => item.id === activeAttempt.assignmentId)?.agentId
      : undefined) ?? root.ownerAgentId;
  const activeAgentName =
    snapshot.agents.find((a) => a.definition.id === activeAgentId)?.definition.name ??
    activeAgentId ??
    '执行成员';

  const startedAtMs = useMemo(() => {
    const valid = attempts
      .map((a) => (a.startedAt ? Date.parse(a.startedAt) : Infinity))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (valid.length > 0) return Math.min(...valid);
    const rootCreated = Date.parse(root.createdAt);
    return Number.isFinite(rootCreated) ? rootCreated : Date.now();
  }, [attempts, root.createdAt]);

  const finishedAtMs = useMemo(() => {
    if (busy) return undefined;
    const valid = attempts
      .map((a) => (a.finishedAt ? Date.parse(a.finishedAt) : 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (valid.length > 0) return Math.max(...valid);
    const rootUpdated = Date.parse(root.updatedAt);
    return Number.isFinite(rootUpdated) ? rootUpdated : Date.now();
  }, [busy, attempts, root.updatedAt]);

  const durationMs = busy
    ? Math.max(0, now - startedAtMs)
    : Math.max(0, (finishedAtMs ?? Date.now()) - startedAtMs);

  const recentSteps = useMemo(() => {
    return activity
      .slice(-5)
      .reverse()
      .map((item) => {
        const isTool = item.kind === 'tool';
        const presentation = isTool ? toolPresentation(item.text, item.state) : null;
        const label = presentation?.label ?? item.text;
        const status =
          presentation?.status ??
          (item.state === 'complete' || item.state === 'completed'
            ? '已完成'
            : item.state === 'streaming' || item.state === 'in_progress'
              ? '进行中'
              : item.state === 'failed'
                ? '失败'
                : item.state);
        const agentName =
          snapshot.agents.find((a) => a.definition.id === item.agentId)?.definition.name ??
          item.agentId;
        const iconState =
          item.state === 'completed' || item.state === 'complete'
            ? 'done'
            : item.state === 'in_progress' || item.state === 'streaming'
              ? 'running'
              : item.state === 'failed'
                ? 'failed'
                : 'other';
        return {
          id: item.id,
          label,
          status,
          agentName,
          iconState,
        };
      });
  }, [activity, snapshot.agents]);

  const currentAction = useMemo(() => {
    const runningTool = activity
      .filter((a) => a.kind === 'tool' && a.state === 'in_progress')
      .at(-1);
    if (runningTool) {
      const pres = toolPresentation(runningTool.text, runningTool.state);
      return `正在${pres.label}`;
    }
    const latest = activity.at(-1);
    if (latest && latest.kind === 'message' && latest.state === 'streaming') {
      return '正在组织回复…';
    }
    if (root.state === 'waiting_children') {
      return '正在等待协作者回复…';
    }
    if (busy) {
      return '正在处理任务…';
    }
    return root.state === 'completed' ? '执行完成' : stateLabel(root.state);
  }, [activity, root.state, busy]);

  // If empty and task is just initialized, return null
  if (activity.length === 0 && attempts.length === 0 && root.state === 'ready') {
    return null;
  }

  // Active running mode
  if (busy) {
    return (
      <section className={s.liveCard} role="status" aria-label="实时执行状态">
        <div className={s.liveHeader}>
          <span className={s.pulseDot} aria-hidden="true" />
          <span className={s.agentPill}>{activeAgentName}</span>
          <span className={s.actionText} title={currentAction}>
            {currentAction}
          </span>
          <span className={s.timer} aria-label={`已耗时 ${formatTimer(durationMs)}`}>
            ⏱ {formatTimer(durationMs)}
          </span>
          <button
            type="button"
            className={s.expandBtn}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起 ▴' : `步骤 (${activity.length}) ▾`}
          </button>
        </div>
        {expanded && (
          <div className={s.expandedBody}>
            {recentSteps.length > 0 ? (
              <ol className={s.stepList} aria-label="最近执行步骤">
                {recentSteps.map((step) => (
                  <li key={step.id} className={s.stepItem}>
                    <span className={s.stepIcon} data-state={step.iconState} aria-hidden="true">
                      {step.iconState === 'done' ? '✓' : step.iconState === 'failed' ? '✗' : '•'}
                    </span>
                    <span className={s.stepLabel}>
                      <span className={s.stepAgent}>[{step.agentName}]</span>
                      {step.label} · {step.status}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={s.stepItem}>准备开始第一步操作…</p>
            )}
            <div className={s.expandedFooter}>
              <button type="button" className={s.processLink} onClick={onInspectProcess}>
                查看完整过程 ↗
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  // Completed or stopped (badge mode)
  const isFailed = root.state === 'failed' || root.state === 'cancelled';
  const badgeTitle = isFailed
    ? `⚠️ 本轮未完成（${stateLabel(root.state)}） · 耗时 ${formatDuration(durationMs)} · ${activity.length} 项步骤`
    : `⚡ 本轮执行完毕 · 耗时 ${formatDuration(durationMs)} · ${collaboratorsCount} 个协作者 · ${activity.length} 项步骤`;

  return (
    <div className={s.badgeContainer} data-state={root.state}>
      <button
        type="button"
        className={s.badgeButton}
        data-status={isFailed ? 'failed' : 'completed'}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        title="点击展开/收起本轮执行摘要"
      >
        <span className={s.badgeIcon}>{isFailed ? '⚠️' : '⚡'}</span>
        <span className={s.badgeText}>{badgeTitle}</span>
        <span className={s.badgeCaret}>{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className={s.badgeExpanded}>
          {recentSteps.length > 0 ? (
            <ol className={s.stepList} aria-label="本轮步骤摘要">
              {recentSteps.map((step) => (
                <li key={step.id} className={s.stepItem}>
                  <span className={s.stepIcon} data-state={step.iconState} aria-hidden="true">
                    {step.iconState === 'done' ? '✓' : step.iconState === 'failed' ? '✗' : '•'}
                  </span>
                  <span className={s.stepLabel}>
                    <span className={s.stepAgent}>[{step.agentName}]</span>
                    {step.label} · {step.status}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={s.stepItem}>本轮未产生独立步骤记录。</p>
          )}
          <div className={s.expandedFooter}>
            <button type="button" className={s.processLink} onClick={onInspectProcess}>
              查看完整过程 ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
