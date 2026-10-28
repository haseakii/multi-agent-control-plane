import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SlidersHorizontal,
  RefreshCw,
  X,
  Bot,
  Zap,
  ChevronDown,
  Settings,
  Check,
  RotateCcw,
} from 'lucide-react';
import {
  currentSessionValues,
  editableSessionOptions,
  inspectAgentSessionSettings,
  readAgentSessionSettings,
  readTaskSessionSettings,
  readTaskExecutionActive,
  saveAgentSessionDefaults,
  readAgentSessionPresets,
  createAgentSessionPreset,
  renameAgentSessionPreset,
  changeAgentSessionPresetArchive,
  sameSessionValues,
  sessionSettingsSummary,
  sessionSettingValuesSummary,
  sessionSettingLabel,
  nextSessionSelection,
  sessionCacheFreshness,
  sessionPresetDraft,
  type AgentSessionSettingsData,
  type SessionSettingValuesData,
  type TaskSessionSettingsData,
  type SessionPresetData,
  type SessionSettingsData,
} from './session-settings';
import {
  readLocalModelCache,
  writeLocalModelCache,
  formatModelLabel,
  type CachedModelOption,
} from './local-model-cache';
export { readLocalModelCache, writeLocalModelCache, formatModelLabel, type CachedModelOption };
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
  confirmedSettings?: SessionSettingsData;
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
        {props.settingsLocked ? '查看运行设置' : '运行设置'}
        {props.values ? ' · 已选' : ''}
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
  settingsLocked,
  confirmedSettings,
  onClose,
}: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const [data, setData] = useState<AgentSessionSettingsData>();
  const [selected, setSelected] = useState<SessionSettingValuesData>({});
  const [pending, setPending] = useState<'cache' | 'inspect' | 'save' | 'preset' | null>('cache');
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [customModelInput, setCustomModelInput] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<SessionPresetData[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState('');
  const [presetNotice, setPresetNotice] = useState('');
  const [presetsVersion, setPresetsVersion] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [renameNames, setRenameNames] = useState<Record<string, string>>({});
  const presetSubmission = useRef<{ id: string; signature: string } | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const freshness = sessionCacheFreshness(data, now);
  const activePresets = presets.filter((preset) => !preset.archived);
  const archivedPresets = presets.filter((preset) => preset.archived);
  const loadedArchived = presets.find((preset) => preset.id === selectedPreset && preset.archived);
  const canSaveValues = verified && freshness === 'fresh';
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setPresetsLoading(true);
    setPresetsError('');
    void readAgentSessionPresets(agentId, controller.signal)
      .then((next) => {
        if (!active || controller.signal.aborted) return;
        if (next.agentId !== agentId || next.presets.some((preset) => preset.agentId !== agentId))
          throw new Error('方案成员不一致，请刷新核对。');
        setPresets(next.presets);
        setRenameNames((previous) =>
          Object.fromEntries(
            next.presets.map((preset) => [preset.id, previous[preset.id] ?? preset.name]),
          ),
        );
      })
      .catch((cause) => {
        if (active)
          setPresetsError(
            controller.signal.aborted
              ? '读取常用方案超时，可重新读取；当前参数仍保留。'
              : errorText(cause),
          );
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (active) setPresetsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentId, presetsVersion]);
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
        if (next.settings) {
          const modelOpt = next.settings.options.find(
            (opt) => opt.category === 'model' || opt.id === 'model',
          );
          if (modelOpt && modelOpt.options.length > 0) {
            writeLocalModelCache(agentId, modelOpt.options);
          }
        }
        const selection = {
          ...(next.settings ? currentSessionValues(next.settings) : {}),
          ...next.defaults.values,
          ...inheritedValues,
          ...values,
        };
        setSelected(selection);
        setVerified(
          !!next.settings &&
            sessionCacheFreshness(next) === 'fresh' &&
            sameSessionValues(selection, currentSessionValues(next.settings)),
        );
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
    if (settingsLocked) return;
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 75000);
    setPending('inspect');
    setError('');
    setNotice('');
    setVerified(false);
    setPresetNotice('');
    try {
      const next = await inspectAgentSessionSettings(
        agentId,
        projectId,
        nextValues,
        controller.signal,
      );
      if (controller.signal.aborted || request.current !== controller) return;
      setData(next);
      if (next.settings) {
        const modelOpt = next.settings.options.find(
          (opt) => opt.category === 'model' || opt.id === 'model',
        );
        if (modelOpt && modelOpt.options.length > 0) {
          writeLocalModelCache(agentId, modelOpt.options);
        }
      }
      setNow(Date.now());
      setSelected(next.settings ? currentSessionValues(next.settings) : {});
      setVerified(true);
      setNotice(
        next.settings && editableSessionOptions(next.settings).length
          ? '已向成员核对。用于下次发送后，执行时会再次确认实际生效。'
          : '已读取。此成员未提供可调整的模型设置，继续使用成员自身设置。',
      );
    } catch (cause) {
      if (request.current === controller) {
        setError(errorText(cause));
        setData((previous) =>
          previous
            ? { ...previous, freshness: 'stale', staleReason: 'inspection-failed' }
            : previous,
        );
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) setPending(null);
    }
  }

  async function save(nextValues: SessionSettingValuesData = selected, reset = false) {
    if (!data || !(reset ? freshness === 'fresh' : canSaveValues) || pending) return;
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
  function choosePreset(id: string) {
    setSelectedPreset(id);
    setVerified(false);
    setError('');
    setNotice('');
    const preset = presets.find((item) => item.id === id);
    if (id === '$native') {
      setSelected({});
      setPresetNotice('已载入成员原生设置，仅用于待发送参数。保存为常用方案或默认前，请先核对。');
    } else if (preset) {
      setSelected(sessionPresetDraft(preset));
      setPresetNotice(
        `已载入“${preset.name}”。用于下次发送后，执行前仍由成员确认；不会修改当前轮或成员默认。保存前请先核对。`,
      );
    }
  }
  function applyPresetResult(saved: SessionPresetData) {
    if (saved.agentId !== agentId) throw new Error('返回的方案不属于当前成员，请刷新核对。');
    setPresets((previous) =>
      previous.some((preset) => preset.id === saved.id)
        ? previous.map((preset) => (preset.id === saved.id ? saved : preset))
        : [...previous, saved],
    );
    setRenameNames((previous) => ({ ...previous, [saved.id]: saved.name }));
  }
  async function createPreset() {
    if (
      pending ||
      !canSaveValues ||
      !presetName.trim() ||
      presetName.trim().length > 80 ||
      activePresets.length >= 32 ||
      presets.length >= 128
    )
      return;
    const name = presetName.trim();
    const signature = JSON.stringify([
      agentId,
      name,
      Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    if (presetSubmission.current?.signature !== signature)
      presetSubmission.current = { id: crypto.randomUUID(), signature };
    const presetId = presetSubmission.current.id;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setPending('preset');
    setPresetsError('');
    setPresetNotice('');
    try {
      const saved = await createAgentSessionPreset(
        agentId,
        presetId,
        name,
        selected,
        controller.signal,
      );
      if (request.current !== controller || controller.signal.aborted) return;
      applyPresetResult(saved);
      setSelectedPreset(saved.id);
      setCreatingPreset(false);
      setPresetName('');
      presetSubmission.current = undefined;
      setPresetNotice(`已保存常用方案“${saved.name}”。成员默认、当前轮和下轮选择保持原样。`);
    } catch (cause) {
      if (request.current === controller) {
        setPresetsError(
          `未能确认方案保存结果：${errorText(cause)}。刷新方案后可核对；相同内容重试会沿用本次保存标识。`,
        );
        setPresetsVersion((version) => version + 1);
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) setPending(null);
    }
  }
  async function managePreset(
    preset: SessionPresetData,
    operation: 'rename' | 'archive' | 'restore',
  ) {
    if (pending) return;
    const name = (renameNames[preset.id] ?? preset.name).trim();
    if (operation === 'rename' && (!name || name.length > 80 || name === preset.name)) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setPending('preset');
    setPresetsError('');
    setPresetNotice('');
    try {
      const saved =
        operation === 'rename'
          ? await renameAgentSessionPreset(
              agentId,
              preset.id,
              preset.revision,
              name,
              controller.signal,
            )
          : await changeAgentSessionPresetArchive(
              agentId,
              preset.id,
              preset.revision,
              operation === 'archive',
              controller.signal,
            );
      if (request.current !== controller || controller.signal.aborted) return;
      applyPresetResult(saved);
      setPresetNotice(
        operation === 'rename'
          ? '方案已重命名。当前任务与参数保持原样。'
          : operation === 'archive'
            ? '方案已归档，可在“已归档”中恢复。已选参数和任务快照保持原样。'
            : '方案已恢复，可重新选用。当前任务与成员默认保持原样。',
      );
    } catch (cause) {
      if (request.current === controller) {
        setPresetsError(
          `${errorText(cause)}${operation === 'restore' ? '。若存在同名方案，请先重命名此归档方案，再恢复；不会覆盖已有方案。' : '。请刷新方案核对版本后再操作。'}`,
        );
        setPresetsVersion((version) => version + 1);
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) setPending(null);
    }
  }
  const options = data?.settings ? editableSessionOptions(data.settings) : [];
  const staleDescription =
    data?.staleReason === 'network-changed'
      ? '网络设置已变化，请重新核对可用选项；最后已知登录记录仍保留。'
      : data?.staleReason === 'readiness-changed'
        ? '连接或登录状态的已知证据已变化，请重新核对选项；这不表示已读取账号身份。'
        : data?.staleReason === 'definition-changed'
          ? '成员启动配置已变化，请重新读取可用选项。'
          : data?.staleReason === 'inspection-failed'
            ? '上次核对未成功，当前显示此前记录，请重新读取。'
            : '选项缓存已过期，请重新读取后再保存方案或默认。';
  function presetManagerRow(preset: SessionPresetData) {
    const name = renameNames[preset.id] ?? preset.name;
    return (
      <li key={preset.id} className={s.presetRow}>
        <div className={s.presetRowTitle}>
          <strong>{preset.name}</strong>
          <span>{preset.archived ? '已归档' : '可选用'}</span>
        </div>
        <small>
          {sessionSettingValuesSummary(preset.values, data?.settings) || '使用成员原生设置'}
        </small>
        <form
          className={s.presetRename}
          onSubmit={(event) => {
            event.preventDefault();
            void managePreset(preset, 'rename');
          }}
        >
          <label>
            <span className={s.srOnly}>{preset.name} 的方案名称</span>
            <input
              value={name}
              maxLength={80}
              disabled={!!pending}
              onChange={(event) =>
                setRenameNames((previous) => ({ ...previous, [preset.id]: event.target.value }))
              }
            />
          </label>
          <button type="submit" disabled={!!pending || !name.trim() || name.trim() === preset.name}>
            重命名
          </button>
          <button
            type="button"
            disabled={!!pending || (preset.archived && activePresets.length >= 32)}
            onClick={() => void managePreset(preset, preset.archived ? 'restore' : 'archive')}
          >
            {preset.archived ? '恢复' : '归档'}
          </button>
        </form>
      </li>
    );
  }
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
        {confirmedSettings && (
          <section className={s.confirmed} aria-label="本轮实际生效设置">
            <strong>本轮实际生效设置</strong>
            <dl>
              {editableSessionOptions(confirmedSettings).map((option) => (
                <Fragment key={option.id}>
                  <dt>{sessionSettingLabel(option)}</dt>
                  <dd>
                    {option.options.find((item) => item.value === option.currentValue)?.name ??
                      option.currentValue}
                  </dd>
                </Fragment>
              ))}
            </dl>
            {!editableSessionOptions(confirmedSettings).length && (
              <p>成员未提供可调整的模型选项。</p>
            )}
          </section>
        )}
        <p className={s.description}>
          {settingsLocked
            ? '任务正在执行，此处可查看本轮设置；执行结束后可读取选项并调整下一轮。'
            : onChange
              ? inheritPrevious
                ? '默认沿用上轮已确认的设置。这里的选择只用于下次发送。'
                : '为本次任务选择模型和思考方式，也可以保存为此成员默认。'
              : '为此成员保存日常默认；每位成员独立设置。'}
        </p>
        <fieldset className={s.controls} disabled={settingsLocked}>
          <details className={s.presets} aria-label="成员常用方案">
            <summary>常用方案（可选）</summary>
            <div className={s.presetHeading}>
              <label htmlFor="session-preset-select">常用方案</label>
              <button
                type="button"
                disabled={!!pending || presetsLoading}
                onClick={() => setPresetsVersion((version) => version + 1)}
              >
                刷新方案
              </button>
            </div>
            <select
              id="session-preset-select"
              value={selectedPreset}
              disabled={!!pending || presetsLoading}
              onChange={(event) => choosePreset(event.target.value)}
            >
              <option value="">当前参数（自定义）</option>
              <option value="$native">成员原生设置</option>
              {activePresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
              {loadedArchived && (
                <option value={loadedArchived.id}>已载入：{loadedArchived.name}（已归档）</option>
              )}
            </select>
            <p>
              {presetsLoading
                ? '正在读取已保存方案…'
                : activePresets.length
                  ? `${activePresets.length} 个可选方案 · 选用仅填入下次发送参数`
                  : '将常用模型组合保存为方案，之后直接选用。'}
            </p>
            {selectedPreset && (
              <p className={s.presetSelection}>
                {sessionSettingValuesSummary(selected, data?.settings) || '下次使用成员原生设置'}
              </p>
            )}
            {!creatingPreset ? (
              <button
                type="button"
                disabled={
                  !!pending || presetsLoading || activePresets.length >= 32 || presets.length >= 128
                }
                onClick={() => setCreatingPreset(true)}
              >
                保存为新的常用方案
              </button>
            ) : (
              <form
                className={s.presetCreate}
                onSubmit={(event) => {
                  event.preventDefault();
                  void createPreset();
                }}
              >
                <label>
                  新方案名称
                  <input
                    value={presetName}
                    maxLength={80}
                    disabled={!!pending}
                    placeholder="例如 日常开发、快速修改"
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                </label>
                {!canSaveValues && <small>先点击下方“核对当前参数”，确认这组值后再保存。</small>}
                <div>
                  <button
                    type="submit"
                    disabled={
                      !!pending ||
                      !canSaveValues ||
                      !presetName.trim() ||
                      activePresets.length >= 32 ||
                      presets.length >= 128
                    }
                  >
                    保存方案
                  </button>
                  <button
                    type="button"
                    disabled={!!pending}
                    onClick={() => setCreatingPreset(false)}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
            {(activePresets.length >= 32 || presets.length >= 128) && (
              <p>每位成员可保留 32 个可选方案、128 个方案总记录（含归档）。归档可释放可选名额。</p>
            )}
            {presetsError && (
              <p className={s.error} role="alert">
                {presetsError}
              </p>
            )}
            {presetNotice && (
              <p className={s.notice} role="status">
                {presetNotice}
              </p>
            )}
            {presets.length > 0 && (
              <details className={s.presetManagement}>
                <summary>管理常用方案（{presets.length}）</summary>
                <p>重命名、归档和恢复只管理方案，不修改默认、已选参数或已有任务。</p>
                {activePresets.length > 0 && <ul>{activePresets.map(presetManagerRow)}</ul>}
                {archivedPresets.length > 0 && (
                  <details>
                    <summary>已归档（{archivedPresets.length}）</summary>
                    <ul>{archivedPresets.map(presetManagerRow)}</ul>
                  </details>
                )}
              </details>
            )}
          </details>
          <section className={s.discovery}>
            <div>
              <strong>
                {pending === 'inspect'
                  ? '正在读取并核对…'
                  : freshness === 'stale'
                    ? '选项缓存需重新核对'
                    : verified
                      ? '已读取并核对'
                      : data?.settings?.source !== 'unavailable' && options.length
                        ? '已有可用设置缓存'
                        : '尚未读取可调整设置'}
              </strong>
              <span>读取会新建无提示会话，首次启动最多等待 60 秒。登录由成员自己管理。</span>
            </div>
            <button type="button" disabled={!!pending} onClick={() => void inspect()}>
              <RefreshCw size={14} />
              {options.length ? '核对当前参数' : '读取可用设置'}
            </button>
          </section>
          <div className={s.observation} aria-label="能力缓存观察">
            <span className={s.freshness} data-state={freshness}>
              {freshness === 'fresh'
                ? '刚读取的可用选项'
                : freshness === 'stale'
                  ? '缓存需更新'
                  : '尚无观察记录'}
            </span>
            {data?.observation && (
              <span>
                观察于 {new Date(data.observation.observedAt).toLocaleString('zh-CN')} · 有效至{' '}
                {new Date(data.observation.expiresAt).toLocaleTimeString('zh-CN')}
              </span>
            )}
            <span>
              能力来源：
              {data?.settings?.source === 'config-options'
                ? 'ACP 会话配置'
                : data?.settings?.source === 'legacy-models'
                  ? 'ACP 兼容模型接口'
                  : '尚未提供可调整选项'}
            </span>
            {freshness === 'stale' && (
              <p role="status">{staleDescription} 此处不会自动启动成员。</p>
            )}
            {data?.observation && (
              <details>
                <summary>观察技术详情</summary>
                <p>观察来自无提示新会话，不代表当前任务已使用这些参数。</p>
                <dl>
                  <dt>观察来源</dt>
                  <dd>{data.observation.source}</dd>
                  <dt>探针会话标识摘要</dt>
                  <dd>{data.observation.sessionIdHash}</dd>
                  <dt>成员配置摘要</dt>
                  <dd>{data.observation.definitionFingerprint}</dd>
                  <dt>就绪证据摘要</dt>
                  <dd>{data.observation.readinessFingerprint}</dd>
                </dl>
                <p>{data.observation.accountIdentityNote}</p>
              </details>
            )}
          </div>
          {pending === 'cache' && <p role="status">正在读取已保存的设置…</p>}
          {options.length > 0 && (
            <div className={s.fields}>
              {options.map((option) => {
                const isModel = option.category === 'model' || option.id === 'model';
                const chosen = selected[option.id] ?? option.currentValue;
                const known = option.options.some((item) => item.value === chosen);
                return (
                  <label key={option.id} className={s.field}>
                    <span>{sessionSettingLabel(option)}</span>
                    <select
                      aria-label={sessionSettingLabel(option)}
                      disabled={pending === 'save'}
                      value={chosen}
                      onChange={(event) => {
                        const next = nextSessionSelection(option, selected, event.target.value);
                        setSelectedPreset('');
                        setSelected(next);
                      }}
                    >
                      {!known && <option value={chosen}>{chosen}（自定义 / 需核对）</option>}
                      {option.options.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    {isModel && (
                      <input
                        type="text"
                        className={s.customModelInput}
                        aria-label="输入自定义模型ID"
                        placeholder="或输入自定义模型 ID（如 claude-sonnet-4.6、gemini-4-argon）"
                        value={customModelInput[option.id] ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCustomModelInput((prev) => ({ ...prev, [option.id]: val }));
                          const trimmed = val.trim();
                          if (trimmed) {
                            const next = nextSessionSelection(option, selected, trimmed);
                            setSelectedPreset('');
                            setSelected(next);
                          }
                        }}
                        disabled={pending === 'save'}
                      />
                    )}
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
            <button
              type="button"
              disabled={!!pending}
              onClick={() => {
                setSelectedPreset('');
                void inspect({});
              }}
            >
              读取成员原生选项
            </button>
            {data && Object.keys(data.defaults.values).length > 0 && (
              <>
                <p>
                  清除此成员保存的默认偏好，之后新任务使用成员自身设置。当前任务和本页下轮选择保持原样。
                </p>
                {freshness !== 'fresh' && <p>恢复前请先读取成员原生选项，确认当前可用设置。</p>}
                <button
                  type="button"
                  disabled={!!pending || freshness !== 'fresh'}
                  onClick={() => void save({}, true)}
                >
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
          {error && (
            <button type="button" onClick={() => void inspect({})}>
              忽略旧偏好，重新读取模型和参数
            </button>
          )}
        </fieldset>
      </div>
      <footer className={s.footer}>
        {onChange && (
          <button
            type="button"
            disabled={!!pending || settingsLocked}
            onClick={() => {
              onChange(undefined);
              onClose();
            }}
          >
            {inheritPrevious ? '沿用上轮设置' : '跟随成员默认'}
          </button>
        )}
        <span className={s.spacer} />
        <button
          type="button"
          disabled={!!pending || !canSaveValues || settingsLocked}
          onClick={() => void save()}
        >
          {options.length ? '保存为成员默认' : '恢复成员原生默认'}
        </button>
        {onChange && (
          <button
            type="button"
            className={s.primary}
            disabled={!!pending || settingsLocked || (!verified && !selectedPreset)}
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

export interface CompactRuntimePillsProps extends Props {
  taskId?: string;
  statusText?: string;
  statusState?: 'applied' | 'failed' | 'requested' | 'unavailable' | 'running';
}

export function CompactRuntimePills({
  taskId,
  agentId,
  agentName,
  projectId,
  values,
  inheritedValues,
  onChange,
  inheritPrevious,
  disabled,
  settingsLocked,
  confirmedSettings,
  statusText,
  statusState,
}: CompactRuntimePillsProps) {
  const [openFullSettings, setOpenFullSettings] = useState(false);
  const [openModelPicker, setOpenModelPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [cachedModels, setCachedModels] = useState<CachedModelOption[]>(() =>
    readLocalModelCache(agentId, agentName),
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  // Background capability cache read (never spawns agent process)
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    void readAgentSessionSettings(agentId, projectId, controller.signal)
      .then((next) => {
        if (!active || controller.signal.aborted) return;
        if (next.settings) {
          const modelOpt = next.settings.options.find(
            (opt) => opt.category === 'model' || opt.id === 'model',
          );
          if (modelOpt && modelOpt.options.length > 0) {
            writeLocalModelCache(agentId, modelOpt.options);
            setCachedModels(readLocalModelCache(agentId, agentName));
          }
        }
      })
      .catch(() => {})
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentId, projectId, agentName]);

  // Close popover when clicking outside
  useEffect(() => {
    if (!openModelPicker) return;
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpenModelPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openModelPicker]);

  const activeModelValue =
    values?.model ||
    inheritedValues?.model ||
    (confirmedSettings?.options.find((o) => o.id === 'model' || o.category === 'model')
      ?.currentValue ??
      '');

  const activeThinkingValue =
    values?.thinking ||
    inheritedValues?.thinking ||
    (confirmedSettings?.options.find((o) => o.id === 'thinking' || o.category === 'thinking')
      ?.currentValue ??
      '');

  const matchedCached = cachedModels.find((m) => m.value === activeModelValue);
  const displayModelLabel = matchedCached
    ? matchedCached.name
    : activeModelValue
      ? formatModelLabel(activeModelValue)
      : '默认模型';

  const isOverridden = !!values && Object.keys(values).length > 0;

  const handleSelectModel = (val: string) => {
    if (!onChange || disabled || settingsLocked) return;
    onChange({ ...(inheritedValues || {}), ...(values || {}), model: val });
    setOpenModelPicker(false);
  };

  const handleCustomModelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customModel.trim();
    if (!trimmed || !onChange || disabled || settingsLocked) return;
    writeLocalModelCache(agentId, [{ value: trimmed, name: trimmed }]);
    setCachedModels(readLocalModelCache(agentId, agentName));
    onChange({ ...(inheritedValues || {}), ...(values || {}), model: trimmed });
    setCustomModel('');
    setOpenModelPicker(false);
  };

  const handleReset = () => {
    if (!onChange || disabled || settingsLocked) return;
    onChange(undefined);
    setOpenModelPicker(false);
  };

  const filteredModels = modelSearch.trim()
    ? cachedModels.filter(
        (m) =>
          m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.value.toLowerCase().includes(modelSearch.toLowerCase()),
      )
    : cachedModels;

  return (
    <div className={s.compactBar} aria-label="执行设置">
      <div className={s.pillsGroup}>
        {/* Agent Pill */}
        <button
          type="button"
          className={s.agentPill}
          disabled={disabled}
          onClick={() => setOpenFullSettings(true)}
          title={`成员：${agentName}（点击管理运行参数）`}
        >
          <Bot size={13} className={s.pillIcon} />
          <span className={s.pillText}>{agentName}</span>
          <Settings size={11} className={s.pillSettingsIcon} />
        </button>

        {/* Model Pill & Popover */}
        <div className={s.modelPillContainer} ref={popoverRef}>
          <button
            type="button"
            className={`${s.modelPill} ${isOverridden ? s.pillOverridden : ''}`}
            disabled={disabled}
            onClick={() => {
              if (settingsLocked) {
                setOpenFullSettings(true);
              } else {
                setOpenModelPicker((prev) => !prev);
              }
            }}
            title={
              settingsLocked
                ? '执行中沿用本轮参数，点击查看'
                : `当前模型：${displayModelLabel}（点击切换）`
            }
          >
            <Zap size={13} className={s.pillIcon} />
            <span className={s.pillText}>{displayModelLabel}</span>
            {activeThinkingValue && <span className={s.thoughtBadge}>{activeThinkingValue}</span>}
            {isOverridden && <span className={s.overrideBadge}>下次生效</span>}
            <ChevronDown size={12} className={s.pillChevron} />
          </button>

          {openModelPicker && (
            <div className={s.modelPopover} role="menu" aria-label="选择模型">
              <div className={s.popoverHeader}>
                <strong>切换模型</strong>
                <span className={s.popoverSub}>即时生效 · 无等待</span>
              </div>

              {cachedModels.length > 4 && (
                <div className={s.popoverSearch}>
                  <input
                    type="search"
                    placeholder="过滤模型..."
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    autoFocus
                  />
                </div>
              )}

              <div className={s.modelOptionList}>
                {filteredModels.map((item) => {
                  const selected = item.value === activeModelValue;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`${s.modelOptionItem} ${selected ? s.modelOptionSelected : ''}`}
                      onClick={() => handleSelectModel(item.value)}
                    >
                      <div className={s.modelOptionMain}>
                        <span className={s.modelOptionName}>{item.name}</span>
                        {item.description && (
                          <small className={s.modelOptionDesc}>{item.description}</small>
                        )}
                      </div>
                      {selected && <Check size={14} className={s.checkIcon} />}
                    </button>
                  );
                })}
                {filteredModels.length === 0 && <div className={s.noModelHint}>暂无匹配模型</div>}
              </div>

              {/* Custom Model ID form */}
              <form className={s.customModelForm} onSubmit={handleCustomModelSubmit}>
                <input
                  type="text"
                  placeholder="或输入模型 ID (如 claude-sonnet-4.6)"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
                <button type="submit" disabled={!customModel.trim()}>
                  使用
                </button>
              </form>

              <div className={s.popoverFooter}>
                {isOverridden && (
                  <button type="button" className={s.resetButton} onClick={handleReset}>
                    <RotateCcw size={12} />
                    恢复成员默认
                  </button>
                )}
                <button
                  type="button"
                  className={s.moreSettingsButton}
                  onClick={() => {
                    setOpenModelPicker(false);
                    setOpenFullSettings(true);
                  }}
                >
                  <SlidersHorizontal size={12} />
                  更多参数与思考等级...
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right side status / hint */}
      <div className={s.compactStatus}>
        {statusText && (
          <span className={s.statusBadge} data-state={statusState || 'info'}>
            {statusText}
          </span>
        )}
      </div>

      {/* Full Settings Dialog */}
      {openFullSettings &&
        createPortal(
          <SessionSettingsDialog
            agentId={agentId}
            agentName={agentName}
            projectId={projectId}
            values={values}
            inheritedValues={inheritedValues}
            onChange={onChange}
            inheritPrevious={inheritPrevious}
            disabled={disabled}
            settingsLocked={settingsLocked}
            confirmedSettings={confirmedSettings}
            onClose={() => setOpenFullSettings(false)}
          />,
          document.body,
        )}
    </div>
  );
}

export function ComposerRuntimeSettings(props: Props) {
  return <CompactRuntimePills {...props} />;
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

  const locked = props.settingsLocked || executionActive !== false;
  const statusState =
    data?.state === 'applied'
      ? 'applied'
      : data?.state === 'failed'
        ? 'failed'
        : data?.state === 'requested'
          ? 'requested'
          : undefined;

  const statusText =
    data?.state === 'applied'
      ? '本轮已确认'
      : data?.state === 'failed'
        ? data.error || '设置未生效'
        : data?.state === 'requested'
          ? '等待成员确认设置'
          : locked
            ? '执行中'
            : error
              ? '读取中…'
              : undefined;

  return (
    <CompactRuntimePills
      taskId={taskId}
      {...props}
      settingsLocked={locked}
      confirmedSettings={data?.confirmed}
      inheritPrevious
      inheritedValues={data?.confirmed ? currentSessionValues(data.confirmed) : data?.requested}
      statusText={statusText}
      statusState={statusState}
    />
  );
}
