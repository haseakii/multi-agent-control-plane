# 总控 UI V2：从模块面板到目标执行工作区

本稿在 V1 的任务优先方向上继续迭代，仍是独立原型，不替换正式 UI。
打开同目录 `control-center-proposal-v2.html` 可离线演示；所有数据和动作均为模拟，
没有 API、模型、ACP 或数据库连接。V1 的 `control-center-proposal.html` 保留供对照。

## V1 → V2 的具体变化

| V1 | V2 | 原因 |
| --- | --- | --- |
| 目标/任务列表与详情并排，项目导航较弱 | 左侧项目与持久化目标记录，中央围绕当前目标展示执行过程 | 用户先找到工作，再阅读一次执行，而不是巡视所有模块 |
| 消息、产物作为详情中的标签页 | 中央目标/执行时间线，右侧同视口审批、任务状态和产物预览 | 结果不再插入长日志下方；查看后能明确返回 |
| 多个子任务同权重罗列 | 正常 Agent/工具事件可折叠，待审批和执行中断保留显式入口 | 降低噪声，同时保留 Agent 身份和审计路径 |
| 配置与日常执行混在同页 | Agent、授权、Boss 资格放在独立设置入口 | 熟练使用者不再每次经过完整注册表单 |
| 失败恢复用一个统一示例展示 | 明确区分可恢复/不可恢复失败；恢复确认解释新 attempt | 避免把恢复说成回滚、保证继续原会话或一律重试 |

1366 宽度仅三栏：左导航、中央阅读区、右上下文。不是四栏同时展开。
1150 以下右栏按需以对话框打开；更窄视口保留中央阅读区，原生 Escape 关闭返回。
手机适配是评审便利，项目当前仍以桌面工作台为主要使用场景。

## 成熟客户端参考与采用边界

以下官方研究由主对话提供。本稿借鉴可复用的信息组织，不宣称逐像素复刻当前版本。
Codex、Claude 为官方文档确认；Cursor、Open WebUI 另有官方图片作为视觉参照。

- [Codex app 官方介绍](https://openai.com/index/introducing-the-codex-app/)：项目组织独立任务线程，在线程内查看工作。总控以持久化目标/任务记录映射这种导航，不把 ACP 临时会话当成领域任务状态。
- [Cursor Agents Window](https://cursor.com/docs/agent/agents-window) 与[官方截图](https://cursor.com/docs-static/images/agent/file-agents-window-final.png)：对话/任务阅读与文件查看共享视口。采用侧栏产物预览，不增加没有后端支持的编辑/发布功能。
- [Cursor Projects](https://cursor.com/docs/agent/projects)：参考协调与执行的区分。总控继续展示具体 Agent 和本次角色，Boss 不是固定厂商模型。
- [Cursor Agent overview](https://cursor.com/docs/agent/overview)：不把别人的检查点能力移植为总控“回滚”。本项目恢复仍使用现有 `resume`，创建新执行尝试。
- [Claude Artifacts 官方说明](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)：对话旁独立产物窗口。采用同视口查看及明确关闭返回，不虚构在线编辑、发布和版本操作。
- [Open WebUI Subagents](https://docs.openwebui.com/features/chat-conversations/chat-features/subagents/) 与[官方界面图片](https://docs.openwebui.com/assets/images/new-chat-placeholder-be568eb047e004bf0757ff35e34b4289.png)：子 Agent 完成后的折叠和导航分层。保留总控 Agent 身份、真实工具事件；不生成模型没有提供的思考日志。

## 后端能力约束

- 左侧“目标记录”是 task/goal 的呈现，不承诺新增聊天会话接口。中央输入明确标为“提交新目标”，不会暗示向执行中的任务追加人类消息。
- 状态、取消、恢复规则沿用 V1 说明中的状态动作矩阵。失败不显示取消；只有 latest attempt failed/interrupted、允许恢复、无活动执行且依赖满足时，才提供恢复。
- 恢复创建新 attempt，保留旧输入与审计记录；不是重试原 HTTP 请求、回滚文件或保证继续 ACP 会话。
- 已完成和已取消不提供取消/恢复。不可恢复失败仅提供诊断和新目标入口。
- 审批必须有真实 task、Agent、action、resource 和 enforcementMode。未知字段应标明未提供，不能猜测风险、影响范围或把 cooperative 说成 enforced。
- 没有“全部批准”、虚构进度百分比、自动重试、模型切换或不存在的检查点按钮。
- 原型仅用明确的合成叶子任务展示取消。正式父任务取消必须呈现子树影响。

## 交互与焦点

正常协作/工具事件用原生 details 折叠，异常及待决策信息不依赖展开后才可发现。
手动选择上下文才移动焦点，状态更新不抢焦点、不强行滚动时间线。
产物预览在侧栏内打开，焦点进入“关闭预览”；关闭回到产物条目。窄屏用对话框，
Escape 返回触发入口。确认批准、恢复、取消时展示本次范围及保存内容。

## 最小落地顺序

1. 先实现目标导航、中央记录、只读上下文/产物预览；复用现有快照与 artifact API。
2. 再接任务内审批和中断处理，服务端提供动作资格；覆盖 409、取消竞态、重复操作、失败不丢草稿与焦点返回。
3. 迁移 Agent/Boss/授权设置，不改现有安全边界；最后统一视觉密度、断点和长内容。

不把本次原型检查当作接入后端的端到端验收。未完成屏幕阅读器全流程、正式对比度认证、
大规模目标历史和实时高频事件压力验证。原 25 文件可靠性/本机开发修复保持独立，未提交推送。

V2 截图、检查记录和明确版本的 PDF 位于
`D:\workspace\multi-agent-control-plane-windows-evidence\ui-review\v2`。
