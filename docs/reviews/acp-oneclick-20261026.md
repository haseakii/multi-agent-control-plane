# ACP 一键安装、登录与使用

日期：2026-10-26。按用户选择对齐“安装 → 登录 → 直接使用，自动处理运行环境”。参考 [ACP 简介](https://agentclientprotocol.com/get-started/introduction)、[目录格式](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md)、[登录协议](https://agentclientprotocol.com/protocol/v1/authentication) 和 [JetBrains 接入流程](https://www.jetbrains.com/help/ai-assistant/acp.html)。

产品卡点击“安装”即提交当前固定版本的幂等请求；目录版本变化时停止提交。安装完成就地登录并选入原草稿，目标、工作目录和已有会话保留，不自动发送任务。安装、连接、登录分别显示，失败可重试，已有程序入口继续提供。

本机安装适配器支持 Windows ZIP、tar.gz / tgz、原生程序、固定版本 npm / uvx 包。npm 使用工作台配套 Node 和私有目录，禁用安装脚本；Python 自动准备校验过的 uv 0.13.5、私有 Python 3.13 和独立环境，仅安装 wheel，不修改全局 PATH、Python 注册表或用户工具目录。静态目录环境经校验后交给启动适配器；托管批处理入口拒绝命令扩展字符。

terminal 登录能力按实际宿主支持声明。终端方法使用 Agent 给出的登录参数与环境，替换普通启动设置并保留解释器入口；成功退出才确认就绪，失败或取消不冒充成功。账号与凭据仍由 Agent 管理。后台预热不会自动打开终端，执行中和已有检查期间拒绝重复登录，关闭服务清理所属进程树。未增加持久领域字段，沿用现有安装记录和迁移。

验证证据：

- 完整回归 163 个文件、847 项通过；源码 Edge 浏览器 26 项通过。后续复查修正另有定向回归，发行构建会再次执行完整门禁。
- `scripts/verify-hermes-usability.mjs` 的 6 个场景包含版本变化不安装、一次安装、就地登录回草稿、无误发送，以及设置、MCP 和阅读区回归。浏览器异常为零。
- `terminal-authentication.test.ts` 使用真实 Windows 交互控制台验证登录成功、失败、禁止后台弹窗和关闭清理；托管入口验证登录环境替换普通目录环境。
- `agent-managed-install.test.ts` 合并覆盖 Python 计划与私有目录、托管批处理、tar 正常安装及越界/链接拒绝，避免按产品重复测试同一规则。
- `.run/acp-idea-20261026/runtime-verification/result.json`：实际下载并校验 uv、准备 Python 3.13.17，在中文目录安装本地无模型测试 wheel 并启动，重复使用时校验已有运行时。

官方目录快照中的 43 个 Windows 条目均可生成安装方案；这不是逐产品安装或账号登录验收。验证未调用真实模型、未复制提供商凭据、未修改日用实例。只提供源码构建依赖、额外外部组件或不兼容当前运行时的产品仍可能安装失败，并保留已有本机入口方式。自动更新、卸载及其他系统的原生终端登录不在本次范围。
