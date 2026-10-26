import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchJSON } from '@/lib/transport';
import { saveAgentWithRecovery } from './agent-save-recovery';
import { z } from 'zod';
import {
  AgentConnection,
  AgentDefinition,
  bridgeScopes,
  configurationError,
  configurationConflict,
  type AgentConnectionData,
} from './agent-config';
import s from './agent-connections.module.css';
import { AgentArguments } from './agent-arguments';
import {
  agentEditorFields,
  clearAgentEditorDraft,
  readAgentEditorDraft,
  writeAgentEditorDraft,
  type AgentEditorFields,
  type AgentEditorRecovery,
  reconcileEditorDraft,
} from './agent-editor-draft';

export function AgentEditor({
  agent,
  disabled,
  active = false,
  onCancel,
  onSaved,
  onReload,
  recovery,
  onBusy,
}: {
  agent?: AgentConnectionData;
  disabled: boolean;
  active?: boolean;
  onCancel: () => void;
  onSaved: (agent: AgentConnectionData) => void;
  onReload: (agent: AgentConnectionData, recovery: AgentEditorRecovery) => void;
  recovery?: AgentEditorRecovery;
  onBusy: (busy: boolean) => void;
}) {
  const current = agent?.definition;
  const [initial] = useState(() => {
    const base = agentEditorFields(current);
    if (recovery)
      return { base, draft: reconcileEditorDraft(recovery.base, recovery.fields, base) };
    try {
      return { base, draft: readAgentEditorDraft(sessionStorage, current?.id, base) };
    } catch {
      return { base, draft: undefined };
    }
  });
  const [staleDraft, setStaleDraft] = useState(
    initial.draft?.changed ? initial.draft.fields : undefined,
  );
  const [fields, setFields] = useState(
    initial.draft && !initial.draft.changed ? initial.draft.fields : initial.base,
  );
  const [cacheStatus, setCacheStatus] = useState('empty');
  const { name, id, command, args, cwd, environment, capabilities, canBeBoss, transport, scopes } =
    fields;
  const updateField = <K extends keyof AgentEditorFields>(key: K, value: AgentEditorFields[K]) =>
    setFields((previous) => ({ ...previous, [key]: value }));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial.base);
  useEffect(() => {
    if (staleDraft) return;
    try {
      setCacheStatus(writeAgentEditorDraft(sessionStorage, current?.id, initial.base, fields));
    } catch {
      setCacheStatus('unavailable');
    }
  }, [fields, initial, current?.id, staleDraft]);
  const clearDraft = () => {
    try {
      clearAgentEditorDraft(sessionStorage, current?.id);
    } catch {
      /* optional storage */
    }
  };
  const [busy, setBusy] = useState(false);
  const [checkingSave, setCheckingSave] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const locked = disabled || busy;
  const list = (text: string) => [
    ...new Set(
      text
        .split(/[,，\r\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];

  async function save(event: FormEvent) {
    event.preventDefault();
    if (locked || busyRef.current || staleDraft || conflict) return;
    busyRef.current = true;
    setBusy(true);
    setCheckingSave(false);
    onBusy(true);
    setError('');
    try {
      const runtimeEdited =
        !current ||
        command.trim() !== current.runtime.command ||
        JSON.stringify(args) !== JSON.stringify(current.runtime.args) ||
        cwd.trim() !== (current.runtime.cwd ?? '') ||
        environment !== (current.runtime.environmentAllowlist?.join('\n') ?? '');
      if (runtimeEdited && !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(command.trim()))
        throw new Error('请填写本机可执行程序的绝对路径，不要填写安装命令或整行 shell 命令。');
      if (
        canBeBoss &&
        !current?.orchestration.canBeBoss &&
        (transport !== 'mcp' || !scopes.includes('boss.orchestration'))
      )
        throw new Error('担任负责人需要 MCP 协作接口及“编排任务”权限，请在协作设置中明确选择。');
      if (runtimeEdited && list(environment).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
        throw new Error('环境配置只接受变量名称（如 PATH），不能填写等号、变量值或令牌。');
      const definition = AgentDefinition.parse({
        ...(current ?? {}),
        id: id.trim(),
        name: name.trim(),
        enabled: current?.enabled ?? false,
        runtime:
          !runtimeEdited && current
            ? current.runtime
            : {
                type: 'acp-stdio',
                command: command.trim(),
                args,
                ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                ...(list(environment).length ? { environmentAllowlist: list(environment) } : {}),
              },
        capabilities: list(capabilities).map(
          (value) =>
            current?.capabilities.find((item) => item.name === value) ?? {
              name: value,
              source: 'configured',
            },
        ),
        auth: current?.auth ?? { mode: 'agent-managed' },
        orchestration: { canBeBoss },
        controlBridge: { transport, scopes },
      });
      const saved = await saveAgentWithRecovery(
        definition,
        async (signal) => {
          if (current) {
            // Update only editable fields; preserve auth, runner selection and permission policy.
            const patch = {
              ...(agent?.definitionHash ? { expectedDefinitionHash: agent.definitionHash } : {}),
              name: definition.name,
              ...(runtimeEdited ? { runtime: definition.runtime } : {}),
              capabilities: definition.capabilities,
              orchestration: definition.orchestration,
              controlBridge: definition.controlBridge,
            };
            return await fetchJSON(
              `/api/agents/${encodeURIComponent(current.id)}`,
              { method: 'PATCH', body: JSON.stringify(patch), signal },
              AgentConnection,
            );
          } else {
            return await fetchJSON(
              '/api/agents',
              { method: 'POST', body: JSON.stringify(definition), signal },
              AgentConnection,
            );
          }
        },
        (signal) => fetchJSON('/api/agents', { signal }, z.array(AgentConnection)),
        () => setCheckingSave(true),
      );
      clearDraft();
      onSaved(saved);
    } catch (failure) {
      setError(configurationError(failure));
      if (configurationConflict(failure)) setConflict(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setCheckingSave(false);
      onBusy(false);
    }
  }

  return (
    <form
      className={s.editor}
      onSubmit={(event) => void save(event)}
      aria-label={agent ? `编辑 ${agent.definition.name}` : '接入本机协作者'}
    >
      <h3>{agent ? `编辑 ${agent.definition.name}` : '接入本机协作者'}</h3>
      <p className={s.hint}>填写已安装的 ACP 启动入口。登录由协作者自身管理。</p>
      {checkingSave && (
        <p className={s.notice} role="status">
          保存回复未收到，正在核对服务端配置。当前输入保留，请稍候。
        </p>
      )}
      {conflict && (
        <div className={s.notice} role="status">
          <p>此成员已被更新。当前输入已保留，先读取最新配置，再决定如何保留你的修改。</p>
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              if (locked || busyRef.current || !current) return;
              busyRef.current = true;
              setBusy(true);
              onBusy(true);
              try {
                const agents = await fetchJSON('/api/agents', undefined, z.array(AgentConnection));
                const latest = agents.find((item) => item.definition.id === current.id);
                if (!latest) throw Error('此成员已被移除；当前输入仍保留，可暂存后返回成员列表。');
                onReload(latest, { base: initial.base, fields });
              } catch (failure) {
                setError(configurationError(failure));
              } finally {
                busyRef.current = false;
                setBusy(false);
                onBusy(false);
              }
            }}
          >
            读取最新配置，保留我的草稿
          </button>
        </div>
      )}
      {staleDraft && (
        <div className={s.notice} role="status">
          <p>
            此成员的配置在草稿保存后发生了变化。当前显示最新配置；选择恢复后，请核对差异再保存。
            只恢复你编辑过的字段，其他更新会保留。
          </p>
          {!!initial.draft?.conflicts.length && (
            <p>
              双方都修改的字段：
              {initial.draft.conflicts
                .map(
                  (key) =>
                    ({
                      name: '显示名称',
                      id: '注册标识',
                      command: '启动程序',
                      args: '启动参数',
                      cwd: '启动目录',
                      environment: '环境变量名称',
                      capabilities: '能力说明',
                      canBeBoss: '负责人角色',
                      transport: '协作接口',
                      scopes: '协作权限',
                    })[key],
                )
                .join('、')}
              。恢复草稿会在这些字段使用你的输入，请核对后保存。
            </p>
          )}
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setFields(staleDraft);
              setStaleDraft(undefined);
            }}
          >
            恢复未保存的草稿
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              clearDraft();
              setStaleDraft(undefined);
            }}
          >
            放弃旧草稿，使用当前配置
          </button>
        </div>
      )}
      {active && (
        <p className={s.notice}>
          此成员正在执行任务，可以收回负责人资格或协作权限。修改启动配置或增加权限需等任务结束，服务端会检查本次变更。
        </p>
      )}
      <fieldset disabled={locked || !!staleDraft} className={s.fields}>
        <label className={s.field}>
          显示名称
          <input
            required
            value={name}
            onChange={(event) => updateField('name', event.target.value)}
            placeholder="例如：代码审阅协作者"
          />
        </label>
        <label className={s.field}>
          可执行程序绝对路径
          <input
            required
            value={command}
            onChange={(event) => updateField('command', event.target.value)}
            placeholder="C:\Tools\agent\agent.exe"
            spellCheck={false}
          />
        </label>
        <AgentArguments value={args} onChange={(value) => updateField('args', value)} />
        <label className={s.field}>
          擅长的能力 · 每行一个
          <textarea
            rows={2}
            value={capabilities}
            onChange={(event) => updateField('capabilities', event.target.value)}
            placeholder={'例如：code.review\nwriting'}
          />
          <small>负责人据此发现和选择协作者；填写内容代表你的配置声明。</small>
        </label>
        <details className={s.details}>
          <summary>协作设置与高级启动选项</summary>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={canBeBoss}
              onChange={(event) => updateField('canBeBoss', event.target.checked)}
            />
            允许担任负责人
          </label>
          <label className={s.field}>
            协作接口
            <select
              value={transport}
              onChange={(event) => updateField('transport', event.target.value as typeof transport)}
            >
              <option value="none">无接口 · 仅接收任务</option>
              <option value="mcp">MCP · 通过控制平面协作</option>
              {!['none', 'mcp'].includes(transport) && (
                <option value={transport}>{transport}（现有配置）</option>
              )}
            </select>
          </label>
          <p className={s.hint}>
            权限仅对控制平面提供的操作生效。协作者自带的工具由其自身及本机环境控制。
          </p>
          <div className={s.scopeList}>
            {bridgeScopes.map(([scope, label, description]) => (
              <label key={scope} className={s.check}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    updateField(
                      'scopes',
                      event.target.checked
                        ? [...scopes, scope]
                        : scopes.filter((value) => value !== scope),
                    )
                  }
                />
                <span>
                  {label}
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </div>
          {transport === 'none' && scopes.length > 0 && (
            <p className={s.error}>关闭接口时请取消所有权限，或明确选择 MCP 接口。</p>
          )}
          <label className={s.field}>
            启动工作目录 · 可选
            <input
              value={cwd}
              onChange={(event) => updateField('cwd', event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className={s.field}>
            继承的环境变量名称 · 每行一个
            <textarea
              rows={2}
              value={environment}
              onChange={(event) => updateField('environment', event.target.value)}
              spellCheck={false}
              placeholder={'例如：PATH\nAPPDATA'}
            />
            <small>只填写变量名称；不填写密码、令牌或变量值。</small>
          </label>
          <label className={s.field}>
            注册标识
            <input
              required
              maxLength={128}
              value={id}
              readOnly={Boolean(agent)}
              onChange={(event) => updateField('id', event.target.value)}
              spellCheck={false}
            />
          </label>
        </details>
      </fieldset>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <p className={s.hint}>
        {agent
          ? '只改名称或能力说明会保留连接状态。修改启动入口或协作配置后，请重新检查连接和登录。'
          : '新成员先保存为停用。请在成员卡片启用，再检查连接与登录。'}
      </p>
      <div className={s.actions}>
        <button type="button" disabled={busy} onClick={onCancel}>
          {dirty && cacheStatus === 'saved' ? '暂存并返回' : '返回成员列表'}
        </button>
        {(dirty || staleDraft) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              clearDraft();
              onCancel();
            }}
          >
            放弃修改
          </button>
        )}
        <button type="submit" className={s.primary} disabled={locked || !!staleDraft || conflict}>
          {busy ? (checkingSave ? '正在确认保存结果…' : '处理中…') : '保存配置'}
        </button>
      </div>
      {dirty && !staleDraft && (
        <p className={s.hint} role="status">
          {cacheStatus === 'saved'
            ? '编辑草稿已保存在此标签页；关闭面板或刷新后可继续，尚未应用到成员。'
            : cacheStatus === 'sensitive'
              ? '输入包含可能的敏感参数，不缓存这份草稿；关闭编辑前请保存配置或放弃修改。'
              : '浏览器未能保存编辑草稿；关闭编辑前请保存配置或放弃修改。'}
        </p>
      )}
    </form>
  );
}
