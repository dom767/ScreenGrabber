@echo off
setlocal
cd /d "%~dp0"
node "%~dp0actions\Build.mjs" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  if not defined AC_NO_PAUSE pause
)
exit /b %EXITCODE%
