@echo off
setlocal
chcp 65001 >nul
"%~dp0.data\control-plane\runtime\node.exe" "%~dp0.data\control-plane\launcher\control-plane.mjs" status
set "_CP_EXIT=%errorlevel%"
if not defined CONTROL_PLANE_NO_PAUSE pause
exit /b %_CP_EXIT%
