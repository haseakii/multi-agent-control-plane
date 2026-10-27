import { useState, useEffect, useMemo } from 'react';
import { toolPresentation } from './activity-presentation';
import { taskFamily, terminal, type SnapshotData, type TaskData } from './adapter';
import { agentActivity } from './agent-activity';
import { failureSummary } from './failure-presentation';
import {
  executionCardSummary,
  extractStepTarget,
  formatDuration,
  formatTimer,
  resolveDelegation,
  stateLabel,
  stripStepTarget,
  type DelegationInfo,
} from './live-execution-model';
import s from './live-execution-card.module.css';

export {
  executionCardSummary,
  extractStepTarget,
  formatDuration,
  formatTimer,
  resolveDelegation,
  stateLabel,
  stripStepTarget,
  type DelegationInfo,
};

export function LiveExecutionCard({
  snapshot,
  root,
  rounds,
  busy,
  onInspectProcess,
  onInspectArtifacts,
}: {
  snapshot: SnapshotData;
  root: TaskData;
  rounds?: TaskData[];
  busy: boolean;
  onInspectProcess: () => void;
  onInspectArtifacts?: () => void;
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

  const delegation = useMemo(
    () => resolveDelegation({ snapshot, root, family }),
    [snapshot, root, family],
  );

  const roundArtifacts = useMemo(() => {
    const familyIds = new Set(family.map((t) => t.id));
    return (
      snapshot.artifacts?.filter(
        (a) =>
          family.some((t) => t.resultArtifactRefs?.includes(a.id)) ||
          (a.taskId && familyIds.has(a.taskId)),
      ) ?? []
    );
  }, [snapshot.artifacts, family]);

  const failureReason = useMemo(() => {
    if (
      root.state !== 'failed' &&
      !attempts.some((a) => a.state === 'failed' || a.state === 'interrupted')
    ) {
      return undefined;
    }
    const failedAttempt = attempts
      .filter((a) => ['failed', 'interrupted'].includes(a.state))
      .sort((a, b) => b.number - a.number)[0];
    if (failedAttempt?.failure) {
      return failureSummary(failedAttempt.failure.message, failedAttempt.failure.code, false);
    }
    return failureSummary(undefined, undefined, false);
  }, [root.state, attempts]);

  const collaborators = useMemo(() => {
    const set = new Set<string>();
    for (const t of family) if (t.ownerAgentId) set.add(t.ownerAgentId);
    for (const a of attempts) {
      const agentId = snapshot.assignments.find((item) => item.id === a.assignmentId)?.agentId;
      if (agentId) set.add(agentId);
    }
    for (const item of activity) if (item.agentId) set.add(item.agentId);
    return set;
  }, [family, attempts, activity, snapshot.assignments]);

  const collaboratorsCount = Math.max(1, collaborators.size);

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
    return activity.slice(-5).map((item) => {
      const isTool = item.kind === 'tool';
      const target = isTool ? extractStepTarget(item.text) : undefined;
      const baseTitle = isTool ? stripStepTarget(item.text) : item.text;
      const presentation = isTool ? toolPresentation(baseTitle, item.state) : null;
      const label = presentation?.label ?? baseTitle;
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
        item.agentId ??
        '成员';
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
        target,
        rawText: item.text,
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
      const baseTitle = stripStepTarget(runningTool.text);
      const pres = toolPresentation(baseTitle, runningTool.state);
      const target = extractStepTarget(runningTool.text);
      const verb = pres.label.startsWith('正在') ? pres.label : `正在${pres.label}`;
      return target ? `${verb}: ${target}` : verb;
    }
    const latest = activity.at(-1);
    if (latest && latest.kind === 'message' && latest.state === 'streaming') {
      return '正在组织回复…';
    }
    if (root.state === 'waiting_children') {
      if (delegation.hasDelegation && delegation.workerName && delegation.subtaskTitle) {
        return `等待协作 · [${delegation.workerName}] 正在处理“${delegation.subtaskTitle}”…`;
      }
      return '正在等待协作者回复…';
    }
    if (busy) {
      return '正在处理任务…';
    }
    return root.state === 'completed' ? '执行完成' : stateLabel(root.state);
  }, [activity, root.state, busy, delegation]);

  // If not busy and task is not in terminal state and not blocked (e.g. newly created draft or ready), don't render.
  if (!busy && !terminal(root) && root.state !== 'blocked') {
    return null;
  }

  // Active running mode
  if (busy) {
    return (
      <section className={s.liveCard} role="status" aria-label="实时执行状态">
        <div className={s.liveHeader}>
          <span className={s.pulseDot} aria-hidden="true" />
          <span className={s.agentPill}>{delegation.leaderName}</span>
          {delegation.hasDelegation && delegation.workerName && (
            <>
              <span className={s.delegationArrow} aria-hidden="true">
                ➜
              </span>
              <span className={s.agentPill}>{delegation.workerName}</span>
            </>
          )}
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
                  <li key={step.id} className={s.stepItem} title={step.rawText}>
                    <span className={s.stepIcon} data-state={step.iconState} aria-hidden="true">
                      {step.iconState === 'done' ? '✓' : step.iconState === 'failed' ? '✗' : '•'}
                    </span>
                    <span className={s.stepLabel}>
                      <span className={s.stepAgent}>[{step.agentName}]</span>
                      {step.label}
                      {step.target && (
                        <span className={s.targetPill} title={step.target}>
                          {step.target}
                        </span>
                      )}
                      <span className={s.stepStatus}> · {step.status}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={s.stepItem}>准备开始第一步操作…</p>
            )}
            <div className={s.expandedFooter}>
              {roundArtifacts.length > 0 && onInspectArtifacts && (
                <button
                  type="button"
                  className={s.artifactLink}
                  onClick={onInspectArtifacts}
                  title="查看本轮生成的所有产物"
                >
                  📄 产物 ({roundArtifacts.length}) ↗
                </button>
              )}
              <button type="button" className={s.processLink} onClick={onInspectProcess}>
                查看完整过程 ↗
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  // Completed, cancelled, failed, or blocked (badge mode)
  const {
    status: badgeStatus,
    icon: badgeIcon,
    text: badgeText,
  } = executionCardSummary({
    state: root.state,
    durationMs,
    collaboratorsCount,
    stepCount: activity.length,
    artifactsCount: roundArtifacts.length,
    failureReason,
    delegation,
  });

  return (
    <div className={s.badgeContainer} data-state={root.state}>
      <button
        type="button"
        className={s.badgeButton}
        data-status={badgeStatus}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        title="点击展开/收起本轮执行摘要"
      >
        <span className={s.badgeIcon}>{badgeIcon}</span>
        <span className={s.badgeText}>{badgeText}</span>
        <span className={s.badgeCaret}>{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className={s.badgeExpanded}>
          {failureReason && (
            <div className={s.failureBanner} role="alert">
              <span className={s.failureIcon} aria-hidden="true">
                ⚠️
              </span>
              <span>
                <strong>执行未完成</strong>：{failureReason}
              </span>
            </div>
          )}
          {recentSteps.length > 0 ? (
            <ol className={s.stepList} aria-label="本轮步骤摘要">
              {recentSteps.map((step) => (
                <li key={step.id} className={s.stepItem} title={step.rawText}>
                  <span className={s.stepIcon} data-state={step.iconState} aria-hidden="true">
                    {step.iconState === 'done' ? '✓' : step.iconState === 'failed' ? '✗' : '•'}
                  </span>
                  <span className={s.stepLabel}>
                    <span className={s.stepAgent}>[{step.agentName}]</span>
                    {step.label}
                    {step.target && (
                      <span className={s.targetPill} title={step.target}>
                        {step.target}
                      </span>
                    )}
                    <span className={s.stepStatus}> · {step.status}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={s.stepItem}>本轮未产生独立步骤记录。</p>
          )}
          <div className={s.expandedFooter}>
            {roundArtifacts.length > 0 && onInspectArtifacts && (
              <button
                type="button"
                className={s.artifactLink}
                onClick={onInspectArtifacts}
                title="查看本轮生成的所有产物"
              >
                📄 产物 ({roundArtifacts.length}) ↗
              </button>
            )}
            <button type="button" className={s.processLink} onClick={onInspectProcess}>
              查看完整过程 ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
