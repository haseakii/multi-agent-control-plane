import React, { useEffect, useState } from 'react';
import { z } from 'zod';
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
  const [open, setOpen] = useState(false),
    [policy, setPolicy] = useState<z.infer<typeof Policy>>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const url = '/api/projects/' + encodeURIComponent(projectId) + '/policy';
  useEffect(() => {
    let active = true;
    setPolicy(undefined);
    setNotice('');
    if (open)
      void fetchJSON(url, undefined, Policy)
        .then((p) => {
          if (active) setPolicy(p);
        })
        .catch(() => {
          if (active) setNotice('读取权限失败，请关闭后重试。');
        });
    return () => {
      active = false;
    };
  }, [url, open]);
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
  return (
    <span className={s.host}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        权限
      </button>
      {open && (
        <section className={s.panel} aria-label="Agent 权限">
          <header>
            <strong>项目 Agent 权限</strong>
            <button aria-label="关闭权限" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          <p>对该项目的后续操作生效，网页与 Codex 共用。</p>
          {policy && (
            <>
              <label>
                工作区文件操作
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
                <label key={key}>
                  {key === 'commands' ? '执行命令' : '访问工作区外文件'}
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
                <label key={key}>
                  {key === 'gitMerge' ? '合并到源项目' : '推送到远程'}
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
              <p className={s.note}>
                自动批准仍逐条留记录。仅适用于适配器能完整识别的文件操作；敏感路径、共享目录和无法识别的请求仍需确认。这些设置只处理
                Agent 发来的权限请求，不能隔离它未上报的自有工具。
              </p>
              <button disabled={busy} onClick={() => void save()}>
                {busy ? '保存中…' : '保存权限'}
              </button>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </span>
  );
}
