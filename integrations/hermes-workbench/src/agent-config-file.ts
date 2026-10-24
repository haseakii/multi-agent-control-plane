import { parseAgentCommands } from './agent-quick-config';
import { sensitiveDraftValues } from './agent-onboarding-draft';

/** Read locally into the existing preview flow. Never register, probe or cache raw file text. */
export async function readAgentConfigFile(file: { size: number; text(): Promise<string> }) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    throw new Error('配置文件为空，请选择包含 ACP 启动配置的 JSON 文件。');
  if (file.size > 262_144) throw new Error('配置文件超过 256 KB，请拆分为每批最多 20 位成员。');
  let text: string;
  try {
    text = (await file.text()).trim();
  } catch {
    throw new Error('无法读取这个文件，请重新选择；已有待接入列表仍保留。');
  }
  if (!text.startsWith('{')) throw new Error('请选择 JSON 配置文件；启动命令可直接粘贴到输入框。');
  // Use exactly the same validation and per-member diagnostics as pasted input.
  return parseAgentCommands(text).map((entry) => {
    const runtime = entry.parsed?.runtime;
    if (runtime && sensitiveDraftValues([runtime.command, ...runtime.args, runtime.cwd ?? '']))
      return {
        name: entry.name,
        error: '启动入口含疑似凭据，未导入此成员。请移除凭据后重新导入，并使用成员自己的登录流程。',
      };
    return entry;
  });
}
