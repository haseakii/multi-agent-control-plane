@echo off
setlocal
chcp 65001 >nul
"%~dp0.run\session-settings-presets-20261025\release\runtime\node.exe" "%~dp0.run\hermes-usable-20261023-r1\start-daily.mjs" %*
set "_CP_EXIT=%errorlevel%"
if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause
exit /b %_CP_EXIT%
