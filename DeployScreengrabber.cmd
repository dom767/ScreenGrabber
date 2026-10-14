@echo off
setlocal
cd /d "%~dp0"

echo.
echo Running DeployScreengrabber...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DeployScreengrabber.ps1" %*
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE% neq 0 (
  echo DeployScreengrabber failed with exit code %EXITCODE%.
) else (
  echo DeployScreengrabber finished successfully.
)
echo.
pause
exit /b %EXITCODE%
