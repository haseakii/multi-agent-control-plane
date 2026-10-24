import s from './workbench.module.css';

export function MemberWorkHint({
  name,
  task,
  disabled,
  onOpen,
  onInspect,
}: {
  name: string;
  task?: { title: string; conversationTaskId: string };
  disabled: boolean;
  onOpen: (taskId: string) => void;
  onInspect: () => void;
}) {
  return (
    <section className={s.connectionHint} aria-label="所选成员正在处理任务">
      <div>
        <strong>{name} 正在处理任务</strong>
        {task && <p>当前任务：{task.title}</p>}
        <p>
          补充同一任务请打开原会话；在这里发送会创建另一项任务。
          当前输入会保留为新任务草稿，不会自动发送到原会话。
        </p>
      </div>
      {task ? (
        <button type="button" disabled={disabled} onClick={() => onOpen(task.conversationTaskId)}>
          打开当前会话
        </button>
      ) : (
        <button type="button" disabled={disabled} onClick={onInspect}>
          查看成员当前任务
        </button>
      )}
    </section>
  );
}
