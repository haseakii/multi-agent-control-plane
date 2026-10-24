import type { Project, Snapshot } from './view-model';
export function ProjectSetupPanel({
  project,
  snapshot,
  busy,
  onSettings,
  onProbe,
}: {
  project: Project;
  snapshot: Snapshot;
  busy: boolean;
  onSettings: () => void;
  onProbe: (id: string) => Promise<void>;
}) {
  const boss = snapshot.agents.find((item) => item.definition.id === project.defaultBossAgentId);
  const eligible =
    !!boss &&
    boss.definition.enabled &&
    boss.definition.orchestration.canBeBoss &&
    boss.definition.controlBridge.transport === 'mcp' &&
    boss.definition.controlBridge.scopes.includes('boss.orchestration');
  const ready =
    eligible &&
    boss?.readiness.runtime === 'ready' &&
    ['ready', 'not_reported'].includes(boss.readiness.auth);
  const workspaceReady = snapshot.workspaceConfigs?.some(
    (item) => item.id === project.id && item.mode !== 'unconfigured',
  );
  if (ready && workspaceReady) return null;
  const needsProbe = eligible && boss && boss.readiness.runtime !== 'ready';
  return (
    <section className="next-step" aria-label="开始前的下一步">
      <span className="step-number">{!eligible ? '2' : '3'}</span>
      <div>
        <strong>
          {!snapshot.agents.length
            ? '接入你的 AI 成员'
            : !eligible
              ? '选一位任务负责人'
              : !workspaceReady
                ? '确认任务使用的文件夹'
                : needsProbe
                  ? '检查负责人的连接'
                  : '完成负责人的登录'}
        </strong>
        <p>
          {!eligible
            ? '只需设置一次。负责人会拆解目标、分配工作并汇总结果；你也可以先保存任务草稿。'
            : !workspaceReady
              ? '已有项目需要先选择文件使用方式，再开始执行。'
              : '连接完成后就可以发起任务。检查连接不会发送模型提示。'}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          needsProbe && workspaceReady ? void onProbe(boss.definition.id) : onSettings()
        }
      >
        {needsProbe && workspaceReady
          ? '检查连接'
          : !workspaceReady && eligible
            ? '设置文件夹'
            : '设置协作成员'}
      </button>
    </section>
  );
}
