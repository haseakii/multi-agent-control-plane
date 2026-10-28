import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import { Shield, X } from 'lucide-react';
import { fetchJSON } from '@/lib/transport';
import s from './agent-permissions.module.css';

const Rules = z.object({
  workspaceFiles: z.enum(['ask', 'auto', 'deny']),
  commands: z.enum(['ask', 'deny']),
  outsideWorkspace: z.enum(['ask', 'deny']),
});

const Policy = z.object({
  revision: z.number(),
  tools: z.record(z.string(), z.enum(['allow', 'deny'])),
  gitMerge: z.enum(['ask', 'deny']),
  gitPush: z.enum(['ask', 'deny']),
  requireEnforcedExecution: z.boolean(),
  agentPermissions: Rules,
});

export function AgentPermissions({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={s.trigger}
        aria-expanded={open}
        aria-label="设置项目 Agent 权限"
        onClick={() => setOpen(true)}
      >
        <Shield size={13} />
        权限
      </button>
      {open && <AgentPermissionsDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  );
}

function AgentPermissionsDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [policy, setPolicy] = useState<z.infer<typeof Policy>>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const url = '/api/projects/' + encodeURIComponent(projectId) + '/policy';

  useEffect(() => {
    const previous = document.activeElement;
    const currentDialog = dialog.current!;
    currentDialog.showModal();
    let active = true;
    setPolicy(undefined);
    setNotice('');
    void fetchJSON(url, undefined, Policy)
      .then((p) => {
        if (active) setPolicy(p);
      })
      .catch(() => {
        if (active) setNotice('读取权限失败，请关闭后重试。');
      });
    return () => {
      active = false;
      currentDialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, [url]);

  async function save() {
    if (!policy || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const { revision, ...rules } = policy;
      const saved = await fetchJSON(
        url,
        {
          method: 'PUT',
          body: JSON.stringify({ ...rules, expectedRevision: revision }),
        },
        Policy,
      );
      setPolicy(saved);
      setNotice('已保存，新的权限请求立即使用此规则。现有等待确认仍由你处理。');
    } catch {
      setNotice('保存失败或设置已被其他窗口修改，请关闭后重新打开。');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-label="项目 Agent 权限"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={s.dialogHeader}>
        <div>
          <div className={s.eyebrow}>安全策略</div>
          <strong>项目 Agent 权限</strong>
          <span className={s.subtitle}>对该项目的后续操作生效，网页与 Codex 共用。</span>
        </div>
        <button type="button" className={s.closeButton} aria-label="关闭权限" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className={s.dialogBody}>
        {!policy && !notice && <div className={s.loading}>正在读取权限配置…</div>}
        {policy && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className={s.form}
          >
            <div className={s.fieldGroup}>
              <label className={s.field}>
                <span className={s.labelTitle}>工作区文件操作</span>
                <select
                  aria-label="工作区文件操作"
                  disabled={busy}
                  value={policy.agentPermissions.workspaceFiles}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      agentPermissions: {
                        ...policy.agentPermissions,
                        workspaceFiles: e.target.value as 'ask' | 'auto' | 'deny',
                      },
                    })
                  }
                >
                  <option value="ask">每次确认</option>
                  <option value="auto">自动批准独立工作区内的文件操作</option>
                  <option value="deny">拒绝</option>
                </select>
              </label>

              {(['commands', 'outsideWorkspace'] as const).map((key) => (
                <label key={key} className={s.field}>
                  <span className={s.labelTitle}>
                    {key === 'commands' ? '执行命令' : '访问工作区外文件'}
                  </span>
                  <select
                    aria-label={key === 'commands' ? '执行命令' : '访问工作区外文件'}
                    disabled={busy}
                    value={policy.agentPermissions[key]}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        agentPermissions: { ...policy.agentPermissions, [key]: e.target.value },
                      })
                    }
                  >
                    <option value="ask">每次确认</option>
                    <option value="deny">拒绝</option>
                  </select>
                </label>
              ))}

              {(['gitMerge', 'gitPush'] as const).map((key) => (
                <label key={key} className={s.field}>
                  <span className={s.labelTitle}>
                    {key === 'gitMerge' ? '合并到源项目' : '推送到远程'}
                  </span>
                  <select
                    aria-label={key === 'gitMerge' ? '合并到源项目' : '推送到远程'}
                    disabled={busy}
                    value={policy[key]}
                    onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
                  >
                    <option value="ask">审阅后确认</option>
                    <option value="deny">禁止</option>
                  </select>
                </label>
              ))}
            </div>

            <div className={s.note}>
              自动批准仍逐条留记录。仅适用于适配器能完整识别的文件操作；敏感路径、共享目录和无法识别的请求仍需确认。这些设置只处理
              Agent 发来的权限请求，不能隔离它未上报的自有工具。
            </div>

            {notice && (
              <p
                className={notice.includes('失败') ? s.errorNotice : s.successNotice}
                role="status"
              >
                {notice}
              </p>
            )}

            <div className={s.dialogFooter}>
              <button type="button" className={s.cancelButton} disabled={busy} onClick={onClose}>
                关闭
              </button>
              <button type="submit" className={s.saveButton} disabled={busy}>
                {busy ? '保存中…' : '保存权限'}
              </button>
            </div>
          </form>
        )}
        {!policy && notice && (
          <div className={s.errorState}>
            <p role="status">{notice}</p>
            <button type="button" className={s.cancelButton} onClick={onClose}>
              关闭
            </button>
          </div>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
