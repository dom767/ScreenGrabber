@echo off
setlocal
cd /d "%~dp0"

call "%~dp0DeployProd.cmd" %*
exit /b %ERRORLEVEL%
