import { useState } from 'react';
import { parseAgentCommand } from './agent-quick-config';
import type { AgentConnectionData } from './agent-config';
import s from './agent-connections.module.css';
import { AgentArguments } from './agent-arguments';

type Runtime = AgentConnectionData['definition']['runtime'];

/** Edits a local draft only. The parent explicitly checks and saves it on retry. */
export function AgentRuntimeRepair({
  runtime,
  onApply,
  onCancel,
}: {
  runtime?: Runtime;
  onApply: (runtime: Runtime) => void;
  onCancel: () => void;
}) {
  const [command, setCommand] = useState(runtime?.command ?? '');
  const [args, setArgs] = useState(runtime?.args ?? []);
  const [cwd, setCwd] = useState(runtime?.cwd ?? '');
  const [error, setError] = useState('');
  return (
    <section aria-label="修正启动入口" className={s.repair}>
      <label className={s.field}>
        程序路径
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="C:/Tools/agent.exe"
          spellCheck={false}
          autoFocus
        />
      </label>
      <p className={s.hint}>使用 Node 适配器时，第一个参数是已安装脚本的路径。</p>
      <AgentArguments value={args} onChange={setArgs} />
      <details className={s.details} open={!!runtime?.cwd}>
        <summary>启动目录（可选）</summary>
        <label className={s.field}>
          启动目录
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="留空使用任务工作区"
          />
        </label>
      </details>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.actions}>
        <button type="button" onClick={onCancel}>
          取消修正
        </button>
        <button
          type="button"
          className={s.primary}
          onClick={() => {
            try {
              const { cwd: _previous, ...base } = runtime ?? {};
              onApply(
                parseAgentCommand(
                  JSON.stringify({
                    ...base,
                    command: command.trim(),
                    args,
                    ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                  }),
                ).runtime,
              );
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          }}
        >
          使用修正后的入口
        </button>
      </div>
      <p className={s.hint}>
        这里只修改本批草稿。点击“接入”或“继续检查”后检查入口、保存配置并连接，不发送任务。
      </p>
    </section>
  );
}
