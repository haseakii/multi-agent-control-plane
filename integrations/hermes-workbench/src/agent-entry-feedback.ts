const messages: Record<string, string> = {
  CONFIG_INVALID: '配置格式不正确，请检查程序路径和参数。',
  WINDOWS_WRAPPER_UNSUPPORTED:
    '请选择可执行程序；Node 适配器请填写 node.exe，并把已安装的脚本路径作为第一个参数。',
  LOCAL_PATH_REQUIRED: '请使用本机磁盘上的完整路径。',
  COMMAND_NOT_ABSOLUTE: '程序路径需要完整填写，例如 C:/Tools/agent.exe。',
  COMMAND_NOT_FILE: '找不到这个程序文件，请检查路径或重新选择已安装的程序。',
  NODE_ENTRY_REQUIRED: '请把已安装的 ACP 脚本完整路径作为第一个参数（.js、.mjs 或 .cjs）。',
  NODE_ENTRY_NOT_FILE: '找不到第一个参数指向的脚本，请检查它的完整路径。',
  CWD_NOT_ABSOLUTE: '启动目录需要填写完整路径，也可以留空使用任务工作区。',
  CWD_NOT_DIRECTORY: '找不到这个启动目录，请修正目录或留空。',
};
export function entryIssueText(issue: { code: string; message: string }) {
  return messages[issue.code] ?? issue.message;
}
export function entryConnectionError(message?: string) {
  return message === 'Agent probe failed.'
    ? '程序未能建立 ACP 连接。请核对入口和参数是否按该产品的 ACP 接入说明填写，再重试检查。'
    : message;
}
