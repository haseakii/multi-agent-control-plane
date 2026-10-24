@echo off
setlocal
for /f "tokens=2 delims=:" %%a in ('chcp') do set "_CP_CODEPAGE=%%a"
chcp 65001 >nul
if "%~1"=="" goto menu
if /i "%~1"=="start" goto start
if /i "%~1"=="stop" goto stop
if /i "%~1"=="help" goto help
echo 未知操作。请使用 start-hermes.cmd start、stop 或 help。
set "_CP_EXIT=2"
goto finish

:menu
set "_CP_MENU=1"
echo Hermes 协作工作台
echo [1] 启动或打开工作台
echo [2] 停止工作台
echo [3] 查看使用说明
echo [4] 退出
choice /c 1234 /n /m "请选择 [1-4]: "
if errorlevel 4 (
  set "_CP_EXIT=0"
  goto finish
)
if errorlevel 3 goto help
if errorlevel 2 goto stop
if errorlevel 1 goto start
set "_CP_EXIT=2"
goto finish

:start
set "_CP_PREVIOUS_NO_PAUSE=%CONTROL_PLANE_NO_PAUSE%"
set "CONTROL_PLANE_NO_PAUSE=1"
call "%~dp0启动工作台.cmd" %2
set "_CP_EXIT=%errorlevel%"
set "CONTROL_PLANE_NO_PAUSE=%_CP_PREVIOUS_NO_PAUSE%"
goto finish

:stop
set "_CP_PREVIOUS_NO_PAUSE=%CONTROL_PLANE_NO_PAUSE%"
set "CONTROL_PLANE_NO_PAUSE=1"
call "%~dp0停止工作台.cmd"
set "_CP_EXIT=%errorlevel%"
set "CONTROL_PLANE_NO_PAUSE=%_CP_PREVIOUS_NO_PAUSE%"
goto finish

:help
echo 启动：start-hermes.cmd start
echo 仅启动后台：start-hermes.cmd start --headless
echo 停止：start-hermes.cmd stop
echo 地址：http://127.0.0.1:8057/
echo 打开后点击“新任务”，输入目标并发送；同一会话底部可以补充和追问。
echo 与中文启动入口和 Codex 共用同一个后台服务及任务记录，可以关闭启动窗口。
echo 使用说明："%~dp0integrations\hermes-workbench\README.md"
echo 部署及备份边界："%~dp0docs\guides\hermes-local-delivery.md"
set "_CP_EXIT=0"

:finish
if defined _CP_MENU (
  if not defined CONTROL_PLANE_NO_PAUSE pause
) else (
  if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause
)
if defined _CP_CODEPAGE chcp %_CP_CODEPAGE% >nul
exit /b %_CP_EXIT%
