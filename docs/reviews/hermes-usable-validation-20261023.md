# Hermes 可用版统一验证记录（2026-10-23）

用户授权独审后统一验证并运行可用版本；后补充明确允许确认 Codex / Antigravity 的已有登录状态。真实模型提示为 0，既有服务和真实旧数据不变。

## 最终版本

- 路径：`.run/hermes-usable-20261023-r1/release`
- 工作台构建标识：`2026-10-23T06:15:07.212Z`
- 标准 `release-main.js`、`control-plane.sqlite`、实例锁、维护接口；监听本机 8057。
- 标准包包含 Node 22.22.2，签名有效；157 个依赖包，原生 SQLite 和 14 个迁移探针成功。
- 个人入口 `启动工作台.cmd`，保留前台控制台，Ctrl+C 正常停止。旧 8047 开发入口未替换。

## 独立静审

`release_review` 对 R3/R4/R5 当前输入、许可证补充、writeBundle 最终字节哈希、首页导航修复、个人启动入口分别只读静审，均报告未发现阻断。未将静审等同于运行通过。

## 实际检查

记录位于 `.run/hermes-usable-20261023-r1/`：

| 内容 | 证据与结论 |
| --- | --- |
| 全套单元/集成 | `unit-results-final.json`：77 文件、469 用例通过 |
| 引擎构建及类型 | `logs/final-engine-build.log`、`logs/final-typecheck.log`：通过 |
| Hermes 类型 | `logs/hermes-typecheck-approved.log`：通过；随后只做格式与构建插件修复 |
| lint | `logs/lint-final.log`：通过；runtime-composition 仅一处调用格式折叠，独审确认语义不变 |
| 最新构建插件严格类型 | TypeScript --noEmit --strict 单独检查 license-notices.ts：通过 |
| 针对性回归 | `logs/navigation-tests.log`：server / web-ui / license-notices 共 6 用例通过 |
| 最终 Web | `logs/hermes-build-sealed.log`：Vite 成功，资源大小警告保留 |
| 最终标准包 | `logs/package-final.log`：许可证、最终资源哈希、原生/迁移探针通过 |
| 浏览器流程 | Edge 8058，输入目标19×17、发送、发现/委派、worker产物、Boss读取汇总323；同一会话继续追问两次，共3轮，6个结果引用 |
| 数据恢复 | Ctrl+C后锁不存在；标准backup输出4文件/2去重产物，restore至新目录成功；浏览器刷新恢复副本后仍见3轮对话与6个结果引用 |
| 真实成员初始化/已有认证 | `real-initialize.json` 与 `real-auth-readiness.json`，Codex和Antigravity连接/登录均ready；没有session/prompt调用 |

本轮新建模拟数据的根任务为 `task-3ed4c89d-1b3a-42b1-b070-e06fa74519e5`。模拟服务及恢复服务均已停止；日用实例使用完全独立的新库，不含模拟任务。

## 发现并修复的问题

1. 部分上游依赖使用双许可证文件名或npm包缺少正文：收集多文本、严格核对包版本/仓库/声明，补入官方完整许可证及SHA来源。缺正文仍使构建失败，不跳过合规校验。
2. Vite在generateBundle之后改写动态导入，旧清单记录中间字节：writeBundle重算实际输出文件哈希，发布器继续逐文件严格校验。
3. Edge通过链接导航首页携带cross-site/navigate/document而被拒绝：只豁免GET精确首页的顶层文档导航；Host、Origin校验保留，API/资产/iframe继续拒绝。真实浏览器证实修复后首页打开。
4. 测试环境短TEMP路径在Windows异步realpath中展开，导致既有工作区身份保护拒绝；Git autocrlf也影响fixture。只在测试进程使用新的完整TEMP路径和core.autocrlf=false，不削弱产品校验或修改全局Git设置。

早期失败报告/包尝试保留在隔离目录；最终使用 `release` 与 `web-sealed`，不得使用中间的 `candidate` / `web-final`。

## 范围边界

没有新模型验收，没有真实旧库迁移；没有声称LocalRunner是OS沙箱。输入/执行中补充/取消恢复的确定性服务端用例通过；本轮浏览器重点验证输入、正常协作、连续追问及重启后持久化，未声称逐一实测全部界面分支。当前可供用户开始实际任务，真实模型返回质量与供应商状态以实际使用为准。
