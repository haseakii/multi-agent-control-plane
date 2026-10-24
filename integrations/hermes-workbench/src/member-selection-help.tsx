import { memberUnavailableReason, type Member, type ExecutionMode } from './agent-selection';
import s from './member-selection-help.module.css';

type NamedMember = Member & { definition: { id: string; name: string } };
export function MemberSelectionHelp({
  agents,
  mode,
  selectedId,
  disabled,
  onInspect,
  onDirect,
}: {
  agents: NamedMember[];
  mode: ExecutionMode;
  selectedId: string;
  disabled: boolean;
  onInspect: (id: string) => void;
  onDirect: (id: string) => void;
}) {
  const unavailable = agents.filter(
    (agent) => agent.definition.id !== selectedId && memberUnavailableReason(agent, mode),
  );
  if (!unavailable.length) return null;
  return (
    <details className={s.help}>
      <summary>为什么其他 {unavailable.length} 位成员暂不可选？</summary>
      <ul>
        {unavailable.map((agent) => {
          const reason = memberUnavailableReason(agent, mode)!;
          const direct = mode === 'collaborative' && !memberUnavailableReason(agent, 'direct');
          return (
            <li key={agent.definition.id}>
              <div>
                <strong>
                  {agent.definition.name} · {reason.label}
                </strong>
                <p>{reason.detail}</p>
              </div>
              <div className={s.actions}>
                {direct && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onDirect(agent.definition.id)}
                  >
                    直接交给 {agent.definition.name}
                  </button>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onInspect(agent.definition.id)}
                >
                  查看 {agent.definition.name} 状态
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
