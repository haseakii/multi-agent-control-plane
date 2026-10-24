import { z } from 'zod';

const EditReview = z.object({
  status: z.literal('complete'),
  tool: z.literal('edit_file'),
  action: z.literal('file.write'),
  parameters: z.object({
    content: z
      .array(
        z.object({
          type: z.literal('diff'),
          path: z.string(),
          oldText: z.string(),
          newText: z.string(),
        }),
      )
      .min(1)
      .max(16),
  }),
});

/** Render text only; a proposed edit is never executable HTML. */
export function PermissionEditPreview({ resource }: { resource: unknown }) {
  const parsed = z.object({ review: EditReview }).safeParse(resource);
  if (!parsed.success) return null;
  return (
    <section aria-label="本次文件修改">
      <p>请核对上方目标文件。任务工作区的改动合入源项目仍需之后审阅。</p>
      {parsed.data.review.parameters.content.map((diff, index) => (
        <details key={index} open>
          <summary>{diff.path.split(/[\\/]/).at(-1)} · 修改前后</summary>
          {/^\[file-content bytes=\d+ sha256=[a-f0-9]{64}\]$/.test(diff.newText) && (
            <p>
              这次修改正文较长，已完整校验文件编辑请求。此处记录正文大小和指纹，不展示代码全文；实际改动可在“文件改动”中审阅，合并仍需你确认。
            </p>
          )}
          <p>修改前</p>
          <pre>{diff.oldText}</pre>
          <p>修改后</p>
          <pre>{diff.newText}</pre>
        </details>
      ))}
    </section>
  );
}
