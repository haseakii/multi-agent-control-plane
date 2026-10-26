# 四个优先产品的自动安装兼容

核对日期：2026-10-26。范围为 Windows x64 的 Codex、CodeBuddy Code、Antigravity、Claude Agent。版本和启动参数来自 [ACP 官方目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)；目录后续更新时仍按用户确认的固定版本安装，不写死此次快照版本。

| 产品 | 本次核对版本 / 分发 | ACP 入口 | 登录 |
| --- | --- | --- | --- |
| Codex | `@agentclientprotocol/codex-acp@2.2.2`，配套 `@openai/codex@0.160.1` | 适配器 `dist/index.js`，stdio；绑定本次安装的原生 CLI | Agent 返回 ChatGPT / API Key 登录方法 |
| CodeBuddy Code | `@tencent-ai/codebuddy-code@2.176.0` | Node 执行无后缀 `bin/codebuddy --acp`；不能误用 HTTP `--serve` | Agent 返回微信、外部账号、企业等方法 |
| Antigravity | `antigravity-acp@1.4.3`，Google Windows ZIP | `agy_acp_server.exe`，stdio | Agent 返回 Google、Gemini Enterprise 等方法 |
| Claude Agent | `@agentclientprotocol/claude-agent-acp@0.95.0`，SDK `0.3.309` | 适配器 `dist/index.js`，stdio | Agent 返回终端登录方法；保留适配器入口并替换 ACP 参数 |

官方依据：

- [Codex ACP README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md) 与安装包元数据：适配器依赖兼容 CLI，`CODEX_PATH` 可绑定实际程序；不能因本机 PATH 有旧 Codex 而串用。
- [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)、[安装要求](https://www.codebuddy.cn/docs/cli/installation)、[命令参数](https://www.codebuddy.cn/docs/cli/cli-reference)：Node 18.20 以上，`--acp` 提供 stdio 接口。工作台使用配套 Node 22。
- [Antigravity 扩展文档](https://antigravity.google/docs/ide/extensions)及官方 ACP 目录：使用 Google 发布的原生服务；ZIP 的完整 SHA-256 为 `54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325`。
- [Claude ACP README](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/README.md)、[Claude 安装文档](https://code.claude.com/docs/en/setup)：适配器要求 Node 22 以上，Windows 使用 SDK 配套原生包；不默认要求用户另装全局 Claude CLI。

## 安装行为

所有固定版本的 npm ACP 共用主体安装、锁文件解析、本机依赖恢复和最终检查，不以产品 ID 白名单决定是否恢复。平台筛选共用 OS/CPU/libc 规则，支持排除项和 npm 别名；产品专用策略只保留原生程序布局及环境绑定。恢复依赖使用锁文件中 npm 官方源的精确 URL 和 SHA-512，校验与安全解压完成后才移入 `node_modules`。

npm 主体仅对识别出的临时网络错误自动恢复一次。下载最多自动尝试三次；永久 HTTP、文件权限、容量及参数错误立即停止，取消不重试。断线只有在完整摘要或强 ETag 能确认内容身份时才续传；服务器忽略 Range 时从零写入，分段响应必须继续到完整对象，响应长度不符不能算成功。校验失败从零重新获取，已有完整缓存通过摘要后直接复用。

已恢复依赖记录逐文件大小及 SHA-256，复用时检查文件内容，不能仅凭版本号跳过。缺文件、同大小损坏或回执损坏会从已校验归档重建。新包先在临时目录解压；替换、命令入口创建或取消失败时恢复旧目录，成功后才保存完整性回执。目录祖先、回执和暂存路径拒绝符号链接或 junction 越界，并对文件数、深度、体积和清单大小设限。

下载请求使用 `Accept-Encoding: identity`，避免 CDN 压缩后的长度和 ETag 与实际 ZIP 字节不一致。安装包大小上限、HTTPS 重定向限制、解压路径与链接检查保持生效。其他目录产品复用通用安装能力，不表示已经逐产品完成兼容验收。

Codex 和 Claude 的 Windows 原生程序共用短路径准备能力，保留辅助程序布局；硬链接不可用时复制，重复调用会校验并复用完整目录，损坏目录则重建。分别通过 `CODEX_PATH` 与 `CLAUDE_CODE_EXECUTABLE` 绑定，避免超过 260 字符的路径下报 `ENOENT`。Claude 曾出现 ACP 握手成功而底层 CLI 无法启动，此边界已复现并修复。终端登录同样保留运行程序绑定。CodeBuddy 的无后缀 Node 入口同时适用于安装、检查和终端登录。原生产品首次启动可能准备运行环境，连接检查默认允许 120 秒。

账号登录继续由各产品处理。安装与 ACP 初始化成功不等于账号已授权，也不等于真实模型任务成功；此改动不复制凭据，不自动完成 OAuth，不修改用户现有成员配置。

## 复验

`scripts/verify-acp-installation.mts` 使用生产安装服务，在独立 SQLite 和安装目录中安装官方包、注册成员并执行真实 ACP `initialize`。不发送模型提示词，不打开登录流程。测试根目录可由 `ACP_TEST_ROOT` 指定，配套 npm 所在发行目录由 `ACP_TEST_RELEASE_ROOT` 指定。

目录快照放在 `node_modules/.cache/acp-compat/registry.json`。可通过 `ACP_TEST_PACKAGE_CACHE` 提供 URL 到已下载官方包的本地映射，生产安装器仍会校验整包摘要；`ACP_TEST_NPM_CACHE` 可指定验收专用的 npm 缓存。Antigravity 验收复用已下载的官方 ZIP，仍重新进行 SHA-256 校验。报告位于测试根目录的 `results.json`，包含真实安装状态和 Agent 声明的登录方式。

本次真实验收：Codex 2.2.2 / CLI 0.160.1、CodeBuddy Code 2.176.0、Claude Agent 0.95.0、Antigravity 1.4.3 均完成空目录安装、注册和 ACP 握手，并返回各自登录方法。Codex 同时复现并修复了超过 260 字符的原生路径问题。程序包包含真实发布的原生运行依赖，复验缓存仍接受生产完整性校验。未执行真实模型调用或其他操作系统验收。

健壮性加强后的定向回归覆盖 16 个文件、75 项，均已通过，包含文件损坏修复、替换及取消回滚、硬链接降级、libc 筛选、错误分类、完整分段下载、原生绑定和原有安装成员流程。其中安装状态集成用例在大包验收并发期间有一次 20 秒超时，停止并发安装后单独复验在约 6 秒内通过。服务端及其 10 个依赖包构建通过；格式与差异检查通过。
