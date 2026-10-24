import { z } from 'zod';

const Review = z.object({
  review: z.object({
    action: z.string().nullable().optional(),
    target: z.string().nullable().optional(),
    expiresAt: z.string().datetime().optional(),
    parameters: z
      .object({
        resolved: z
          .object({
            command: z.string().min(1).optional(),
            workingDirectory: z.string().min(1).optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  }),
});
/** Display adapter-resolved fields only; never infer safety from a tool title or command flags. */
export function approvalSummary(resource: unknown) {
  const review = Review.safeParse(resource);
  const r = review.success ? review.data.review : undefined;
  const command = r?.action === 'process.execute';
  return {
    title: command
      ? '运行一条命令'
      : r?.action === 'file.write'
        ? '修改工作区文件'
        : r?.action === 'file.read'
          ? '读取文件'
          : '执行成员操作',
    command: command ? r?.parameters?.resolved?.command : undefined,
    directory: command ? r?.parameters?.resolved?.workingDirectory : undefined,
    target: r?.target ?? undefined,
    expiresAt: r?.expiresAt,
    impact: command
      ? '允许后，成员会执行下方完整命令。'
      : r?.action === 'file.write'
        ? '允许后，成员会写入下方目标文件。'
        : '允许后，成员会继续当前请求的操作。',
    risk: command
      ? '命令可能读写文件、启动子进程或访问网络。工作目录不是安全沙箱，请核对完整命令，不要仅凭成员的用途说明判断安全。'
      : r?.action === 'file.write'
        ? '本次只决定这项文件操作。源项目的合并仍需单独审阅；任务工作区不限制成员自有工具的系统权限。'
        : '操作的实际权限取决于成员及操作系统。信息不完整时，请先查看请求详情。',
  };
}
