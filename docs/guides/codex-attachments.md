# 从 Codex 交付图片和文件

在 Codex 中给出附件或明确的本地文件路径，再说明交给哪个协作成员、修改哪个项目即可。例如：

> 把这张参考图和需求文件交给 Antigravity，在 Northstar 项目的独立工作区做一个页面。继续追问时保留附件和已有代码，合并由我审阅。

Codex 使用 `collaboration_submit_task` 或 `collaboration_continue_task` 的 `attachments` 参数传递文件。无需先切到网页上传，也无需把图片转成大段 base64 发给模型。成员按自身实际声明的图片能力接收原生图片；其他文件从任务内的实际副本读取。文件解析能力取决于成员。

```json
{
  "projectId": "project-from-list-projects",
  "agentId": "agent-from-list-agents",
  "objective": "根据这两份资料修改页面，保留人工审阅合并。",
  "idempotencyKey": "unique-for-this-message",
  "attachments": [
    { "path": "D:/references/page.png" },
    { "path": "D:/references/requirements.txt", "mimeType": "text/plain" }
  ]
}
```

追问仍使用最新任务 ID。省略 `attachments` 时保留原附件；本轮指定附件会追加到历史输入，不替换原件。也可通过 `attachmentIds` 引用已上传的资料。

```json
{
  "taskId": "latest-task-id",
  "content": "保留原图和原需求，按新文件继续修改。",
  "idempotencyKey": "unique-for-the-followup",
  "attachments": [{ "path": "D:/references/followup.txt" }]
}
```

每条消息最多 10 个附件，单个 20 MB，合计 40 MB。必须是 Codex 的本地 MCP 进程可读取、用户明确指定的普通文件；不接受目录、通配符、网络路径、设备路径或符号链接。不要扫描凭据或上传用户未指定的文件。若聊天附件没有可读的本地路径，应明确说明，不能把“模型在对话中看过图片”当作已交付原文件。

MCP 客户端先读取并校验全部指定文件，再通过直连 loopback 的认证接口上传原始字节。任务只收到附件编号，过程记录不包含原始本地路径或二进制。上传失败不会发送任务；发送结果不确定时先查询原任务，用相同编号重试相同消息。相同发送编号与位置会复用原附件；内容变化必须使用新的发送编号。

网页中可查看同一任务的图片、文件链接、执行过程、当前改动与实时预览。托管输入目录不进入代码审阅快照，合并仍由用户确认。现有命令审批与越界访问策略不变。

## 本机稳定入口

本仓库的 `scripts/collaboration-client.mjs --connection <现有连接文件>` 会跟随连接文件中当前选择的 release。以后更新后台版本无需反复改 Codex 的启动参数。既有 token、项目授权与工具清单继续使用；入口不创建新凭据，不扩大授权。

更新工具参数后，已连接的 Codex 会话需要重连 `local_collaboration` 才能加载新描述。MCP 配置格式与重连入口见 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp)。更改宿主配置必须复用 `scripts/lib/codex-mcp-config.mjs`，保留行结束符，并在写入前完整解析 TOML；`[windows]` 必须独立成行。
