import s from './agent-connections.module.css';

/** Keep exact argv boundaries across every configuration form. */
export function AgentArguments({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div role="group" aria-label="启动参数">
      <p className={s.hint}>每个参数单独填写，路径或文字中有空格也不用加引号。</p>
      {!value.length && <p className={s.hint}>未添加额外参数。产品不需要参数时可直接继续。</p>}
      {value.map((arg, index) => (
        <div className={s.argument} key={index}>
          <label className={s.field}>
            参数 {index + 1}
            <textarea
              rows={1}
              value={arg}
              spellCheck={false}
              onChange={(event) =>
                onChange(value.map((item, i) => (i === index ? event.target.value : item)))
              }
            />
          </label>
          <button
            type="button"
            aria-label={`移除参数 ${index + 1}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, ''])}>
        添加参数
      </button>
      {value.some((arg) => arg === '') && (
        <p className={s.hint}>空白项会作为空参数传给程序；如果不需要，请移除该项。</p>
      )}
    </div>
  );
}
