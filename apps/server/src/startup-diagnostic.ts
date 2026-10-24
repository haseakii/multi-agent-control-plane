/** Translate only a verified port conflict; preserve other startup failures. */
export function startupPortConflict(error: unknown, port: number | undefined): string | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'EADDRINUSE' ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return undefined;
  return (
    '启动失败：本机端口 ' +
    port +
    ' 已被占用（EADDRINUSE）。\n' +
    '请在运行副本的 config.json 中将 port 改为一个空闲端口后重试；使用 --config 时请修改指定的配置文件。\n' +
    '如需保留原端口，请先确认占用服务，再通过它自己的正常停止方式关闭。\n' +
    '本程序不会终止占用端口的进程，也不会删除已有数据或其他实例的锁文件。'
  );
}

export type StartupStage = 'config' | 'assets' | 'data' | 'listen';

export function startupFailureDiagnostic(
  error: unknown,
  port: number | undefined,
  stage: StartupStage,
): string | undefined {
  const conflict = startupPortConflict(error, port);
  if (conflict) return conflict;
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  if (error.code === 'INSTANCE_LOCKED')
    return '启动未就绪：数据目录仍由活跃实例持有，或无法确认锁的所有者。已确认退出且身份完整的锁会自动恢复；当前锁已保留。\n请复用现有工作台，或使用“停止工作台”正常停机后重试。不要直接删除锁或覆盖数据库；无法确认所有者时，按 RUN.txt 保留原件并恢复到新私有目录。';
  if ((error.code === 'EACCES' || error.code === 'EPERM') && stage === 'listen')
    return '启动失败：本机端口监听被拒绝。请在配置文件中将 port 改为另一个可用端口后重试；不要修改防火墙、ACL 或关闭安全保护。';
  if (error.code === 'EACCES' || error.code === 'EPERM')
    return stage === 'data'
      ? '启动失败：数据目录或其中的文件不可写、不可访问，或正被其他程序占用。请在指定配置中将 dataDir 指向新的可写私有目录后重试；保留原数据。\n请勿以管理员权限、修改 ACL 或关闭安全保护来绕过；已有数据请按 RUN.txt 的停机备份/恢复步骤处理。'
      : '启动失败：配置或程序文件不可访问。请将完整程序复制到新的可读、可写私有目录，确认 --config 指向可读取的配置后重试。不要更改 ACL 或关闭安全保护。';
  if (error.code === 'ENOSPC')
    return '启动失败：存储空间不足（ENOSPC）。请为新的私有运行目录选择有足够空间的位置后重试；保留原数据和无法确认所有者的锁。\n仅在原生文件句柄已验证属于本次创建的锁时尝试清理；原语不可用时保留锁，不按路径删除。';
  return undefined;
}
