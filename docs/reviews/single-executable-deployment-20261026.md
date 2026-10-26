# Windows 单文件部署复查

目标：普通用户下载一个 EXE，打开后直接进入工作台。运行环境、安装目录、端口与升级由本机适配器处理。

## 交付方式

`scripts/windows/WorkbenchLauncher.cs` 是独立的 Windows 启动适配器，内嵌经过清单校验的完整发行包，不向核心引入桌面框架依赖。使用 Windows 自带 .NET Framework 4.8，带普通用户权限清单；配套 Node/npm、网页、生产依赖和完整许可均内置。运行时无需开发工具或手动解压，添加第三方 ACP 程序才按需下载。

首次在用户目录安装，EXE 显示准备进度，并通过系统 URL 关联打开默认浏览器；后续同一 EXE、安装目录固定 EXE、开始菜单均可进入。EXE 的后台命令不经过 CMD。目录包的命令入口也通过固定系统 URL 关联打开浏览器；失败明确区分后台已就绪与浏览器未打开，并给出地址。

## 安装与更新边界

- 新安装选择可用端口并持久保存；已有安装不改端口、MCP 连接或权限。
- 每个安装的启动操作互斥；共享缓存另有互斥。资源 ZIP 和清单分别校验，缓存按清单逐文件检查后才运行程序。
- 使用显式 Windows 长路径访问，避免中文及深目录中的 260 字符限制。缓存失效保留在原位，另建完整副本并原子更新索引，避免移动被后台进程占用的目录。中断暂存件继续保留。
- 打开较新版时复用原升级事务：检查空闲、停机、一致备份、新代次恢复、核对记录与权限。任务或成员安装活跃时先打开原版，稍后重开新版；旧 EXE 不会自动降级。
- 固定 EXE 的更新使用原子替换并保留旧副本；当前安装已较新时不会用旧下载文件替换它。开始菜单失败不冒充核心服务启动失败。
- 数据、工作区、账号授权与程序缓存分开；不复制提供商凭据，不删除旧代次，也不自动恢复或重放任务。

发行清单新增构建时间，保留旧清单的上游构建时间兼容；缺少可靠先后信息或时间相同时拒绝自动替换，保留显式升级入口。不涉及新的数据库领域字段。

## 验证

`verify-windows-executable.mjs` 只复制一个 EXE，覆盖无系统 Node 路径、无效环境 Node 钩子、中文及特殊字符路径、端口占用、重复/并发打开、固定入口替换、原下载改名后仍可启动、缓存损坏恢复及恢复后复用、正常停止。可附 `--previous` 对真实旧发行包验证保留项目、旧版本与备份的升级。证据保留在 `.run/deploy-oneclick-20261026`，原型实测使用上一个公开版本作为旧版本；最终发行门禁重新构建并验证。

少量单测负责端口选择、版本先后与旧清单兼容、系统浏览器调用边界、活跃任务暂缓升级；不按每个产品重复同一矩阵。`publish.mjs` 集成原有编译、完整测试、Hermes 浏览器、目录首装门禁，并新增最终 EXE 构建与实测。

真实启动器窗口可枚举；Computer Use 因无法可靠确认当前浏览器 URL 而停止，随后停止全部窗口操作。这项可视检查未计为通过，最终默认浏览器窗口显示仍需在目标机器复核。HTTP 就绪、地址解析和隔离部署测试与可视证据分开。当前 EXE 未代码签名；包完整性检查不提供发布者身份认证，也不保证消除 Windows 下载提示。未验证干净标准用户虚拟机、企业应用控制策略或每种默认浏览器配置。

参考：[Microsoft 资源嵌入与执行权限清单](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/resources)、[长路径支持](https://github.com/microsoft/dotnet/blob/main/Documentation/compatibility/long-path-support.md)、[系统进程与 URL 关联启动](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start)、[代码签名与 SmartScreen](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)。
