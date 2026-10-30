# Multi-Agent Control Plane

本地优先、供应商中立的多 Agent 协作控制台。通过 ACP 连接本机 Agent，让用户选择执行成员或负责人，统一管理任务、工作目录、消息、附件、产物和人工审批。

Agent 与角色分开：任何具备资格和权限的成员都可以担任 **Boss / 负责人**。任务与结果持久保存，独立于某次 ACP 会话；提供商登录由 Agent 自身管理。

## Quick Start

### Windows：下载一个 EXE，直接打开

在 [GitHub Releases](https://github.com/haseakii/multi-agent-control-plane/releases) 下载 Windows x64 的 **Hermes-Workbench-…-windows-x64.exe**，双击即可。**无需解压、安装系统 Node / pnpm、修改配置或手填端口。** 工作台程序与配套 Node/npm、网页和依赖均在 EXE 内，首次自动准备私有安装并打开浏览器；添加 ACP 成员时再按需联网下载和登录。

以后打开同一个 EXE、安装目录的 **工作台.exe**，或开始菜单中的 **Hermes 工作台** 即可；重复打开会复用已有服务。下载新版后直接打开，空闲时自动备份、升级并核对历史与权限；有任务未结束时先打开当前版本，稍后重开新版再升级。打开旧 EXE 不会自动降级。

安装默认位于 `%LOCALAPPDATA%\MultiAgentControlPlane`，程序缓存位于 `%LOCALAPPDATA%\MultiAgentControlPlaneCache`。数据与下载文件分开，删除下载文件不影响已安装入口；关闭网页后后台继续运行。Windows 10/11 x64 使用系统内置 .NET Framework 4.8；当前 EXE 尚未代码签名，系统可能提示未知发布者。

ACP 下载和安装可在“协作成员 → 添加 / 下载 ACP → 已下载程序与安装记录”查看。每条新记录从安装开始就显示可复制的完整安装位置，默认在 `%LOCALAPPDATA%\MultiAgentControlPlane\agents` 下；Python 共享环境位于同级 `runtimes`。直接下载显示已接收大小，有总大小时显示百分比；npm / Python 依赖安装等无法获知总量的步骤显示当前阶段和耗时。关闭安装窗口后后台继续，重新打开记录即可查看；下载完成后还需要安装和连接检查。

进行中的安装也会显示在产品目录上方，每个步骤都有进度条；总量未知时显示活动条，不编造百分比。点击“取消下载 / 安装”会停止本次网络下载及安装进程，等后台停止后显示“已取消”。未完成文件保留，“重新安装”会使用新的目录；已安装成员和账号不受影响。进入“检查连接”时程序已安装完成，此阶段等待检查结束即可。

### 从源码启动开发控制台

前置条件：**Node.js 22+（当前验证版本为 22.22.2）、pnpm 10.11.0**；使用 Git 工作树和代码审阅时还需要 Git。下面命令均从仓库根目录执行，终端示例使用 PowerShell。

**1. 安装锁定依赖并构建工作区包。**

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

`pnpm --version` 应为 `10.11.0`，与根目录 `packageManager` 和 CI 一致。共享包通过 `dist` 导出，首次启动前必须构建；修改 `packages/*` 后也需要重新构建相关包及其依赖方。

**2. 在第一个终端启动 API，明确使用开发数据目录。**

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:CONTROL_PLANE_DB = "$PWD/.data/development/control-plane.sqlite"
pnpm dev:server
```

**3. 在第二个终端启动网页。**

```powershell
pnpm dev:web
```

打开 [开发控制台](http://127.0.0.1:5173/)。API 使用 [3000 端口](http://127.0.0.1:3000/health)，Vite 将 `/api` 和 `/health` 代理给它。可在另一个终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:5173/health
```

两处都应返回 `status: ok` 和 `service: multi-agent-control-plane`。首次默认空库，启动与查看页面不会发送模型提示。分别在两个服务终端按 Ctrl+C 停止。IDE 调试、热更新和数据隔离见 [本地开发指南](docs/guides/local-development.md)。

### 使用 Windows 完整发布包

ZIP 完整目录包保留给维护和自定义部署：完整解压后双击 **打开工作台.cmd**，或在 PowerShell 中运行 `.\打开工作台.cmd`。它与 EXE 共用安装、启动和升级逻辑，首次安装默认放在 `%LOCALAPPDATA%\MultiAgentControlPlane`。安装目录继续提供 **启动工作台.cmd**、**停止工作台.cmd**、**升级工作台.cmd** 和 **恢复工作台.cmd**。ACP 程序在“协作成员 → 添加 / 下载 ACP”中下载和登录，也可使用本机已有入口。

工作台地址由启动器直接打开；新安装优先使用 **3000**，被占用时自动选择可用端口并保存。已有安装保留原端口和客户端连接配置；本机已有的日用 Hermes 安装使用 [8057](http://127.0.0.1:8057/)。关闭浏览器不会停止后台服务。

源码开发控制台与日用 Hermes 工作台共用核心引擎，启动方式和页面功能各有侧重。`pnpm build` 构建 `apps/*` 与 `packages/*`；Hermes 网页还依赖单独准备的上游源码和依赖，构建方法见 [Hermes 集成说明](integrations/hermes-workbench/README.md)。新克隆的仓库不包含本机安装目录，根目录的中文快捷脚本仅适用于已经完成安装的本机环境。

日常启动、首次安装、升级与恢复见 [交付指南](docs/guides/simple-delivery.md)。

## 完成第一次协作

1. **准备项目和工作目录。** 新建项目时可使用托管空目录；Windows 也支持验证并关联已有本地目录。处理代码时选择合适的独立任务目录或 Git 工作树；Git 工作树需要源仓库已有提交。核对执行影响确认中的实际路径后再发送。
2. **一键安装 ACP 成员。** Hermes 打开“协作成员 → 添加 / 下载 ACP”，在产品卡上点击“安装”，工作台自动下载固定版本、准备运行环境、配置入口并检查连接，无需填写路径。Node.js 使用工作台自带版本；Python 包使用自动下载的私有 uv / Python 环境，不修改系统 Python、全局 PATH 或注册表。“已有程序 / 详情”保留本机入口方式；“已下载程序与安装记录”可查看进度、失败重试和路径。源码控制台使用“成员与设置 → 添加成员”。
3. **登录后直接使用。** 安装完成后点击“登录并使用”；需要终端的成员会打开独立登录窗口。登录成功即选入未发送草稿，保留原目标和工作目录；不会自动发送任务。连接、登录和安装状态分别显示，登录取消或失败可在原页面重试。不报告登录状态的成员会明确标注。源码控制台需选择有负责人资格及 `boss.orchestration` 权限的成员；Hermes 也支持“直接交给成员”。
4. **发送目标并跟踪原任务。** Boss 可以发现成员、委派子任务、读取持久化产物后继续汇总。运行中的补充要求在安全提示边界带入；结束后的追问建立关联轮次，保留前文、结果引用和原始附件。
5. **检查结果并处理审批。** 任务完成、实时文件差异和页面预览用于检查执行结果；固定代码审阅、批准、本地合并和远端推送是分别确认的操作。失败、中断或回复丢失时，先查询原任务与工作目录，再决定恢复或追问。

可以先保存任务草稿，准备好成员后再执行。真实 Agent 的安装、登录和模型使用由你选择；启动控制台不要求预先绑定某个供应商。已有适配器的离线配置检查见 [真实 Agent 预检](docs/guides/real-agent-preflight.md)。

## 交互体验与人机工学亮点

- **高频输入人机工学优化**：
  - **快捷键快速提交**：任务目标描述框与任务执行补充指令框全面支持 `Ctrl+Enter` / `Cmd+Enter` 键盘快捷提交，提高重度键盘与极客操作流转效率。
  - **输入草稿本地自动防丢（LocalStorage）**：输入的目标草稿内容按项目独立在本地实时暂存；误关闭标签、意外刷新或切换项目时自动恢复未发送内容，任务成功启动或保存后自动清除。
  - **示例提示词智能追加**：点击示例引导词（如“分析问题”、“审查代码”）采用智能换行追加而非直接覆盖，防止用户已构思文本意外丢失。
- **交付产物富文本代码审阅与快捷复制**：
  - **Unified Diff 代码补丁智能高亮**：自动识别 `diff` / `.patch` 代码交付成果，分栏展示行号、绿色新增（`+`）、红色删除（`-`）以及定位块语法着色，提升代码审查直观度。
  - **一键复制交付产物**：成果预览面板右上角集成一键复制按钮，并提供 2 秒“已复制 ✓”的即时视觉动效反馈。
- **审批安全风险智能三级标识**：
  - 根据审批调用工具与行为类型自动评估风险等级：
    - 🔴 **高危操作（Danger）**：涉及系统命令执行、终端交互、文件破坏性删除、远端推送等操作；
    - 🟡 **写入变更（Warning）**：涉及文件覆写、本地合并、补丁应用等；
    - 🔵 **常规只读（Info）**：涉及只读检索、状态查询等；
  - 帮助人工审核把关时一眼辨识危险操作边界。
- **轻量浮动 Toast 通知体系**：
  - 自研零外部依赖的轻量 Toast 通知层，操作反馈悬浮于右上角，4 秒自动渐隐且支持手动关闭，彻底解决旧版顶部静态警告横幅推挤主界面布局抖动的问题。

## 从 MCP 客户端接入

在 Hermes 的 **接入应用 · MCP** 中选择项目和客户端，授予“任务与追问”或“只查看”，再使用直接显示的完整配置或安装入口连接。“其他 MCP 客户端”生成通用 stdio 配置，无需手填 HTTP 地址。已有连接可管理多个项目，撤销某个连接不会删除任务和附件。客户端连接与提供商登录分别管理。

首次使用没有项目时，可在此窗口填写项目名称并点击“创建项目并选中”，然后点击“授权并生成接入”；创建项目不会自动授权或运行任务。按钮不可点时，旁边会说明是未勾选项目、项目目录不可用，还是列表读取失败；读取失败可点“重新读取项目”。

外部 stdio MCP 客户端通过同一个引擎读取项目、成员、任务进展和产物，也可按授权提交、追问、取消任务或准备固定审阅。提交后保留返回的任务 ID，使用游标读取增量进展；同一请求重试保留原幂等键，后续轮次使用最新任务 ID。人工权限决定、批准、合并和推送在网页处理。

源码 API、发行包前台入口与安装后入口均提供客户端管理和 ACP 安装接口。前台模式的 MCP 连接需要服务保持运行；安装模式继续使用统一启动器按需启动。新环境需要自行建立客户端连接，本机既有的 `local_collaboration` 配置不会随源码克隆提供。连接文件包含私有本地令牌，应保留在私有目录。详见 [MCP 接入与权限边界](docs/guides/hermes-local-delivery.md#网页与外部-agent-入口)。

运行设置先显示已缓存选项，点击“读取可用设置”会通过无提示 ACP 会话读取模型和参数，最多等待 60 秒。运行中的任务可查看已确认参数，结束后再调整下一轮。对话区可点“放大对话”阅读，按 Esc 返回，未发送草稿保留。成员自己的 MCP 初始化失败需结合该成员日志排查；工作台接入配置不会代替它管理的 MCP 配置。

自动安装支持 Windows 的 ZIP、tar.gz / tgz、原生可执行文件、固定版本 npm 和 uvx 分发；目录需要提供本平台入口。npm 安装禁用脚本，Python 仅安装 wheel，依赖源代码构建或额外外部组件的产品可能需要已有本机入口。手动注册仍需绝对路径；`.cmd` / `.bat` 由下载管理的适配器处理，不能直接作为手动 ACP 主进程入口。账号授权始终由成员自己管理。

## 项目逻辑与目录

```text
用户 / 网页 / MCP 客户端
          |
    项目、成员与权限
          |
    持久任务、分派与执行尝试
          |
    工作目录 → LocalRunner → ACP 会话 → Agent
          |
    消息投递、产物落库、负责人继续汇总
          |
    人工检查、固定审阅、独立确认合并 / 推送
```

| 目录                                            | 职责                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| `apps/server`                                   | Fastify API、运行组合、成员接入、任务编排、发布服务 |
| `apps/web`                                      | 源码开发控制台，React + Vite                        |
| `integrations/hermes-workbench`                 | Hermes Web 适配与构建，复用同一核心引擎             |
| `packages/core`                                 | 领域模型、ID、Zod 契约与共享规则                    |
| `packages/task-engine`                          | 任务状态机、执行尝试、指令、上下文与项目记忆        |
| `packages/acp-runtime`、`packages/runner`       | ACP 生命周期与本机进程管理，分别负责协议和进程      |
| `packages/message-router`、`packages/fleet-mcp` | 可审计消息投递、内部协作桥及外部 MCP 客户端         |
| `packages/policy`、`packages/workspace`         | 策略、审批、工作目录、Git 审阅、合并、推送与清理    |
| `packages/storage`、`packages/artifact-store`   | SQLite / Drizzle、迁移、仓储接口与文件产物存储      |
| `tests/e2e`、`scripts`                          | 浏览器回归、完整发布包与安装维护工具                |
| `docs`                                          | 架构、ADR、开发指南、路线与按日期保留的验收记录     |

V0 聚焦单机协作闭环：**用户 → Boss → 发现成员 → 委派 Worker → 持久化结果 → Boss 继续 → 最终回复**。已有实现还覆盖任务草稿、取消与恢复、关联追问、输入附件、项目记忆与搜索、SSE 进展、独立工作区和人工 Git 交付。预留的 CLI、Context、Orchestrator 等目录不等于已经提供独立产品或分布式部署。

架构全景与规范契约见 [架构技术白皮书 (ARCHITECTURE.md)](ARCHITECTURE.md)、[总览](docs/architecture/overview.md)、[V0 范围](docs/architecture/v0-scope.md) 和 [V0 交付记录](docs/roadmap/v0-delivery-checklist.md)。按日期的真实 Agent 记录与确定性模拟测试分别说明验证范围。

## 开发数据与配置

按 Quick Start 启动时，SQLite 位于仓库的 `.data/development/control-plane.sqlite`，附件保存在 SQLite 中，结果产物、工作目录和目录缓存默认在同级的 `artifacts`、`workspaces` 和 `cache` 下。数据库打开时自动应用仓库内的迁移。

| 源码 API 环境变量          | 用途                                              |
| -------------------------- | ------------------------------------------------- |
| `HOST`、`PORT`             | API 监听地址和端口，默认 `127.0.0.1:3000`         |
| `CONTROL_PLANE_DB`         | SQLite 路径，建议像 Quick Start 一样设为绝对路径  |
| `CONTROL_PLANE_ARTIFACTS`  | 可选覆盖结果产物目录，默认跟随数据库所在目录      |
| `CONTROL_PLANE_WORKSPACES` | 可选覆盖托管工作目录，默认跟随数据库所在目录      |
| `CONTROL_PLANE_DEMO`       | 显式设为 `1` 时填入演示记录；真实使用保持默认关闭 |

`pnpm dev:server` 的进程工作目录为 `apps/server`；未设置数据库变量时，默认文件为该目录下的 `.data/control-plane.sqlite`。设置绝对路径可以让终端与 IDE 使用明确、独立的数据。源码开发入口要求每个数据目录只运行一个 API 进程；发布服务另有实例锁和安装管理，开发服务应使用自己的数据目录。

完整发布服务通过 `config.json` 配置端口、数据目录和日志；`dataDir` 相对该配置文件解析。安装后的当前版本与配置由 `installation.json` 选择。源码数据、发布数据及本机旧验收目录分别管理，升级不会将源码构建自动替换进已运行的服务。

## 验证

安装依赖后从仓库根目录执行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

浏览器回归另需 Playwright 浏览器：

```powershell
pnpm exec playwright install chromium
pnpm test:e2e
```

Windows 已安装 Edge 时，可改为：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm test:e2e
```

浏览器测试会启动自己的 API / Web 服务，占用 **3000 / 4173**，每次默认使用新的临时数据目录。运行前先停止自己启动的冲突开发服务；若设置 `CONTROL_PLANE_E2E_DATA_DIR`，每轮使用新的专用目录。默认套件使用确定性目录元数据；联网检查独立执行：

```powershell
pnpm test:e2e:live
```

该命令只验证官方 ACP 目录元数据刷新。单元、进程及浏览器回归使用模拟 Agent，不调用真实模型。状态矩阵由纯逻辑测试负责，入口保留代表性集成验证；增加用例前见 [测试范围与成本](CONTRIBUTING.md#test-scope-and-cost)。

## 发布、升级与备份

发布构建当前限定已准备锁定依赖和 Hermes 上游源码的 **Windows x64** 机器，Node 需为带有效 OpenJS 签名的 **22.22.2**。从仓库根目录生成一个新目录：

```powershell
node scripts/publish.mjs --output release/new-version
```

统一入口编译服务端与工作区包，运行本地测试，检查并构建 Hermes 网页，打包 Node、依赖和迁移，再逐文件验证完整性。构建输出和旁边的 `*-validation` 保存验证证据；构建不安装软件，也不自动升级当前服务。

日用升级选择完整新包，由安装管理器正常停机、备份、恢复验证并切换当前版本；异常时保留原数据和诊断，使用恢复入口。备份包含任务、输入附件与引用的结果产物，**外部源目录、Agent 安装及提供商凭据需自行管理**。已有工作区可能仍被历史任务引用，清理应走工作区维护流程。详见 [启动、升级和恢复](docs/guides/simple-delivery.md) 及随包 `RUN.txt`。

## 执行与权限边界

- 本机单用户服务，默认 loopback，并检查 Host / Origin；不作为公开互联网或多租户服务部署。
- Agent 认证由 Agent 自管，任务负载不携带提供商凭据。Agent 之间通过控制平面通信并保留审计，大结果通过产物引用传递。
- 策略控制已由控制平面介入的调用及适配器实际上报的权限请求，按真实执行边界记录 `enforced`、`cooperative` 或 `unavailable`。LocalRunner 与 Git 工作树不提供 OS 安全沙箱，也不保证拦截 Agent 自有工具。
- 新执行与异步写入边界重新核对当前授权；审批、审阅、合并及推送分别处理。任务失败或超时不会自动取得重试许可。

开发约束见 [AGENTS.md](AGENTS.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。本仓库代码采用 [Apache-2.0](LICENSE)；Hermes 上游及打包依赖保留各自许可证，Hermes 的授权范围见 [集成许可说明](integrations/hermes-workbench/README.md#限制与下一步)。
