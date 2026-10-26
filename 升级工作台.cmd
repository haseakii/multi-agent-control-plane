@echo off
setlocal
chcp 65001 >nul
"%~dp0.data\control-plane\runtime\node.exe" "%~dp0.data\control-plane\launcher\control-plane.mjs" update %*
set "_CP_EXIT=%errorlevel%"
if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause
exit /b %_CP_EXIT%
