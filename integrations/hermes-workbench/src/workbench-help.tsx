import { useEffect, useRef, useState } from 'react';
import s from './workbench-help.module.css';

const codexExample =
  '使用 local_collaboration 查看已授权项目和可用成员；在我选定的项目中委派一个实际改代码任务，完成后保留工作区供继续追问，并给我工作台链接。代码合并由我审阅。';

export function WorkbenchHelp({
  onClose,
  onMembers,
  onNewTask,
  onCurrentTask,
  hasCurrentTask,
}: {
  onClose: () => void;
  onMembers: () => void;
  onNewTask: () => void;
  onCurrentTask: () => void;
  hasCurrentTask: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyState, setCopyState] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-labelledby="workbench-help-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id="workbench-help-title">开始使用工作台</h2>
        <button type="button" aria-label="关闭使用说明" onClick={onClose} autoFocus>
          ×
        </button>
      </header>
      <div className={s.body}>
        <p>从任务开始。成员配置只在首次接入或需要修复连接时处理。</p>
        <ol>
          <li>
            <strong>选择成员和工作目录</strong>
            <p>
              “直接交给成员”由一位 Agent
              执行；“由负责人安排协作”允许具备编排权限的成员安排分工。已有项目沿用目录和权限，新空目录适合试做。
            </p>
            <button type="button" onClick={onMembers}>
              接入或检查协作成员
            </button>
          </li>
          <li>
            <strong>写清目标，发送任务</strong>
            <p>
              说明要改什么、验收效果和限制。Ctrl + Enter 发送，Enter
              换行。配置草稿和任务输入会保留，发送才开始执行。
            </p>
            <button type="button" onClick={onNewTask}>
              去新建任务
            </button>
          </li>
          <li>
            <strong>在同一会话看过程、改动和预览</strong>
            <p>
              右侧“过程”显示执行与交接；“文件改动”查看实际代码；“页面预览”会随静态页面文件保存自动更新。需要编译或启动开发服务的项目仍需按命令权限处理。
            </p>
          </li>
          <li>
            <strong>继续追问，或失败后直接重试</strong>
            <p>
              执行中可补充要求；完成后在原会话继续修改。失败时先看“过程”中的原因，再直接重试，已有改动会保留。重试不是回滚；另建任务也不会自动继承原会话上下文。
            </p>
          </li>
          <li>
            <strong>核对代码后，再由你批准合并</strong>
            <p>
              在“文件改动”准备固定差异并审阅。执行成功不等于已经合并。项目“权限”可配置文件自动审批；命令、越界访问和合并仍按各自规则处理。
            </p>
          </li>
        </ol>
        {hasCurrentTask && (
          <button type="button" className={s.primary} onClick={onCurrentTask}>
            查看当前任务过程
          </button>
        )}
        <details>
          <summary>直接从 Codex 使用</summary>
          <p>
            在已接入 local_collaboration 的 Codex 中，可以直接发起任务。
            配置了后台启动入口时，无需先打开网页或保留启动窗口。网页和 Codex
            共用任务记录，网页提供预览及人工审阅。
          </p>
          <blockquote>{codexExample}</blockquote>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(codexExample);
                setCopyState('已复制，可粘贴到 Codex；尚未发送任务。');
              } catch {
                setCopyState('无法自动复制，可选中上面的示例文字复制。');
              }
            }}
          >
            复制 Codex 任务示例
          </button>
          {copyState && <p role="status">{copyState}</p>}
        </details>
        <details>
          <summary>接入多个 ACP 产品</summary>
          <p>
            打开“协作成员 → 接入本机协作者”，从产品目录找本机入口，或粘贴、选择 JSON
            文件批量导入启动配置。文件先在浏览器中预览，确认接入后才检查本机程序。已完成的成员可先用，失败项可单独重试；登录由各产品自身处理。接入流程使用已安装程序，不会自动安装软件。
          </p>
        </details>
        <details>
          <summary>上下文、记忆和缓存</summary>
          <p>
            继续追问会关联原会话历史、产物与已接受的项目记忆，未合并代码会带入后续工作区。查看“过程”中的实际记录。模型缓存只展示
            Agent 上报的数据；未上报不代表为零，也不保证多个 Agent 共享缓存。
          </p>
        </details>
        <p className={s.note}>
          需要停止本机服务时运行“停止工作台.cmd”；下次从 Codex
          调用会自动重新启动。遇到实例锁提示时保留数据和锁，先按诊断确认原实例。
        </p>
      </div>
    </dialog>
  );
}
