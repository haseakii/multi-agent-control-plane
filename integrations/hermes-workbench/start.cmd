@echo off
call "%~dp0..\..\start-hermes.cmd" start %*
exit /b %errorlevel%
