import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, RefreshCw, X } from 'lucide-react';
import {
  currentSessionValues,
  editableSessionOptions,
  inspectAgentSessionSettings,
  readAgentSessionSettings,
  readTaskSessionSettings,
  readTaskExecutionActive,
  saveAgentSessionDefaults,
  sameSessionValues,
  sessionSettingsSummary,
  sessionSettingValuesSummary,
  sessionSettingLabel,
  nextSessionSelection,
  type AgentSessionSettingsData,
  type SessionSettingValuesData,
  type TaskSessionSettingsData,
} from './session-settings';
import s from './agent-session-settings.module.css';

type Props = {
  agentId: string;
  agentName: string;
  projectId?: string;
  values?: SessionSettingValuesData;
  inheritedValues?: SessionSettingValuesData;
  onChange?: (values: SessionSettingValuesData | undefined) => void;
  inheritPrevious?: boolean;
  disabled?: boolean;
  settingsLocked?: boolean;
};

function errorText(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError')
    return '读取超时，请稍后重试；任务和草稿仍保留。';
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** Opening only reads cached capabilities; discovery and validation are explicit, prompt-free actions. */
export function SessionSettingsControl(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={s.trigger}
        disabled={props.disabled}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <SlidersHorizontal size={15} />
        运行设置{props.values ? ' · 已选' : ''}
      </button>
      {open &&
        createPortal(
          <SessionSettingsDialog {...props} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function SessionSettingsDialog({
  agentId,
  agentName,
  projectId,
  values,
  inheritedValues,
  onChange,
  inheritPrevious,
  onClose,
}: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const [data, setData] = useState<AgentSessionSettingsData>();
  const [selected, setSelected] = useState<SessionSettingValuesData>({});
  const [pending, setPending] = useState<'cache' | 'inspect' | 'save' | null>('cache');
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    node.showModal();
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    void readAgentSessionSettings(agentId, projectId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setSelected({
          ...(next.settings ? currentSessionValues(next.settings) : {}),
          ...next.defaults.values,
          ...inheritedValues,
          ...values,
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorText(cause));
        else if (request.current === controller) setError('读取设置超时，可以重新读取。');
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (request.current === controller) setPending(null);
      });
    return () => {
      request.current?.abort();
      request.current = undefined;
      controller.abort();
      node.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [agentId, projectId]);

  async function inspect(nextValues: SessionSettingValuesData = selected) {
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 45000);
    setPending('inspect');
    setError('');
    setNotice('');
    setVerified(false);
    try {
      const next = await inspectAgentSessionSettings(
        agentId,
        projectId,
        nextValues,
        controller.signal,
      );
      if (controller.signal.aborted || request.current !== controller) return;
      setData(next);
      setSelected(next.settings ? currentSessionValues(next.settings) : {});
      setVerified(true);
      setNotice(
        next.settings && editableSessionOptions(next.settings).length
          ? '已向成员核对。用于下次发送后，执行时会再次确认实际生效。'
          : '已读取。此成员未提供可调整的模型设置，继续使用成员自身设置。',
      );
    } catch (cause) {
      if (request.current === controller) setError(errorText(cause));
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) setPending(null);
    }
  }

  async function save(nextValues: SessionSettingValuesData = selected, reset = false) {
    if (!data || (!verified && !reset) || pending) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setPending('save');
    setError('');
    setNotice('');
    try {
      await saveAgentSessionDefaults(
        agentId,
        data.defaults.revision,
        nextValues,
        controller.signal,
      );
      if (controller.signal.aborted || request.current !== controller) return;
      // A save may return a different envelope across releases; refresh the authoritative revision.
      const next = await readAgentSessionSettings(agentId, projectId, controller.signal);
      if (request.current !== controller) return;
      if (!sameSessionValues(next.defaults.values, nextValues))
        throw new Error('成员默认已被其他窗口更新，请重新打开核对。');
      setData(next);
      setNotice(
        reset
          ? '已恢复成员原生默认。当前任务、上轮设置和本页下轮选择保持原样。'
          : '已保存成员默认。新任务可使用；当前任务和上轮设置保持原样。',
      );
    } catch (cause) {
      if (request.current === controller) {
        setError(`未能确认保存结果：${errorText(cause)}。请关闭后重新打开核对，避免重复覆盖。`);
        setVerified(false);
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) setPending(null);
    }
  }
  const options = data?.settings ? editableSessionOptions(data.settings) : [];
  return (
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-labelledby="session-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>成员运行设置</span>
          <h2 id="session-settings-title">{agentName}</h2>
        </div>
        <button
          type="button"
          className={s.close}
          aria-label="关闭运行设置"
          autoFocus
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className={s.body}>
        <p className={s.description}>
          {onChange
            ? inheritPrevious
              ? '默认沿用上轮已确认的设置。这里的选择只用于下次发送。'
              : '为本次任务选择模型和思考方式，也可以保存为此成员默认。'
            : '为此成员保存日常默认；每位成员独立设置。'}
        </p>
        <section className={s.discovery}>
          <div>
            <strong>
              {pending === 'inspect'
                ? '正在读取并核对…'
                : verified
                  ? '已读取并核对'
                  : data?.settings?.source !== 'unavailable' && options.length
                    ? '已有可用设置缓存'
                    : '尚未读取可调整设置'}
            </strong>
            <span>读取使用无提示会话，不发送任务。登录由成员自己管理。</span>
          </div>
          <button type="button" disabled={!!pending} onClick={() => void inspect()}>
            <RefreshCw size={14} />
            {options.length ? '重新读取' : '读取可用设置'}
          </button>
        </section>
        {pending === 'cache' && <p role="status">正在读取已保存的设置…</p>}
        {options.length > 0 && (
          <div className={s.fields}>
            {options.map((option) => {
              const chosen = selected[option.id] ?? option.currentValue;
              const known = option.options.some((item) => item.value === chosen);
              return (
                <label key={option.id} className={s.field}>
                  <span>{sessionSettingLabel(option)}</span>
                  <select
                    disabled={!!pending}
                    value={chosen}
                    onChange={(event) => {
                      // Models can change all dependent options; ask the member to provide fresh defaults.
                      const next = nextSessionSelection(option, selected, event.target.value);
                      setSelected(next);
                      void inspect(next);
                    }}
                  >
                    {!known && <option value={chosen}>{chosen}（需重新核对）</option>}
                    {option.options.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {option.description && <small>{option.description}</small>}
                  {option.options.find((item) => item.value === chosen)?.description && (
                    <small>
                      {option.options.find((item) => item.value === chosen)?.description}
                    </small>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {data && !options.length && !pending && (
          <p className={s.empty}>
            模型、思考等级和上下文长度由成员管理。只有成员实际提供的选项才会出现在这里。
          </p>
        )}
        <p className={s.context}>
          上下文容量随模型而定；成员未提供可调选项时，由成员管理。已用上下文可在任务过程里查看。
        </p>
        <details className={s.nativeOptions}>
          <summary>重新发现成员选项</summary>
          <p>
            忽略已保存的模型偏好，读取成员自身设置。适合旧模型不可用或选项已经变化时使用；已保存的默认不会被删除。
          </p>
          <button type="button" disabled={!!pending} onClick={() => void inspect({})}>
            读取成员原生选项
          </button>
          {data && Object.keys(data.defaults.values).length > 0 && (
            <>
              <p>
                清除此成员保存的默认偏好，之后新任务使用成员自身设置。当前任务和本页下轮选择保持原样。
              </p>
              <button type="button" disabled={!!pending} onClick={() => void save({}, true)}>
                恢复成员原生默认
              </button>
            </>
          )}
        </details>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={s.notice} role="status">
            {notice}
          </p>
        )}
      </div>
      <footer className={s.footer}>
        {onChange && (
          <button
            type="button"
            disabled={!!pending}
            onClick={() => {
              onChange(undefined);
              onClose();
            }}
          >
            {inheritPrevious ? '沿用上轮设置' : '跟随成员默认'}
          </button>
        )}
        <span className={s.spacer} />
        <button type="button" disabled={!!pending || !verified} onClick={() => void save()}>
          {options.length ? '保存为成员默认' : '恢复成员原生默认'}
        </button>
        {onChange && (
          <button
            type="button"
            className={s.primary}
            disabled={!!pending || !verified}
            onClick={() => {
              onChange({ ...selected });
              onClose();
            }}
          >
            用于下次发送
          </button>
        )}
      </footer>
    </dialog>
  );
}

export function ComposerRuntimeSettings(props: Props) {
  const cacheKey = JSON.stringify([props.agentId, props.projectId, props.values]);
  const [cached, setCached] = useState<{
    key: string;
    settings: AgentSessionSettingsData['settings'];
  }>();
  useEffect(() => {
    if (!props.values || !Object.keys(props.values).length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    // This endpoint reads the existing capability cache and never starts an Agent.
    void readAgentSessionSettings(props.agentId, props.projectId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setCached({ key: cacheKey, settings: next.settings });
      })
      .catch(() => {
        /* Raw selected values remain visible when the cache is unavailable. */
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [cacheKey]);
  return (
    <section className={s.runtimeBar} aria-label="下次发送的运行设置">
      <div className={s.runtimeCopy}>
        <span className={s.runtimeLabel}>{props.agentName} · 下次发送</span>
        <span className={s.runtimeSummary}>
          {props.values
            ? Object.keys(props.values).length
              ? `${sessionSettingValuesSummary(props.values, cached?.key === cacheKey ? cached.settings : undefined)} · 执行前由成员确认`
              : '下次使用成员原生设置，执行前由成员确认'
            : '使用成员默认；可选择实际支持的模型和思考等级'}
        </span>
      </div>
      <SessionSettingsControl {...props} />
    </section>
  );
}

export function TaskRuntimeSettings({ taskId, ...props }: Props & { taskId: string }) {
  const [data, setData] = useState<TaskSessionSettingsData>();
  const [executionActive, setExecutionActive] = useState<boolean>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    let timer: number | undefined;
    setData(undefined);
    setExecutionActive(undefined);
    setError('');
    async function read() {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10000);
      try {
        const [next, running] = await Promise.all([
          readTaskSessionSettings(taskId, controller.signal),
          readTaskExecutionActive(taskId, controller.signal),
        ]);
        if (active) {
          setData(next);
          setExecutionActive(running);
          setError('');
        }
      } catch (cause) {
        if (active) setError(errorText(cause));
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = window.setTimeout(() => void read(), 5000);
      }
    }
    void read();
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [taskId]);
  const summary = data?.confirmed ? sessionSettingsSummary(data.confirmed) : '';
  const locked = props.settingsLocked || executionActive !== false;
  return (
    <section className={s.runtimeBar} aria-label="本轮运行设置">
      <div className={s.runtimeCopy}>
        <span className={s.runtimeLabel}>
          {data?.state === 'applied'
            ? '本轮已确认'
            : data?.state === 'failed'
              ? '设置未生效'
              : data?.state === 'requested'
                ? '等待成员确认设置'
                : '本轮设置'}
        </span>
        <span className={s.runtimeSummary}>
          {summary ||
            (data?.state === 'unavailable'
              ? '此历史任务未记录模型设置'
              : data?.state === 'requested'
                ? '确认后显示实际模型和参数'
                : data?.state === 'failed'
                  ? data.error || '成员未接受设置，提示未发送'
                  : data?.state === 'applied'
                    ? '使用成员自身设置'
                    : error
                      ? '暂时无法读取，稍后自动重试'
                      : '正在读取…')}
        </span>
        {props.values && <small>已选择下轮覆盖；发送后确认实际生效。</small>}
        {locked && <small>本轮设置已冻结，执行结束后可调整。运行中的补充要求沿用本轮设置。</small>}
        {data?.state === 'failed' && summary && <small className={s.error}>{data.error}</small>}
      </div>
      <SessionSettingsControl
        {...props}
        disabled={props.disabled || locked}
        inheritPrevious
        inheritedValues={data?.confirmed ? currentSessionValues(data.confirmed) : data?.requested}
      />
    </section>
  );
}
