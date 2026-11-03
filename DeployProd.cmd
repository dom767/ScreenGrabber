@echo off
rem Wrapper only — logic is in actions\DeployProd.mjs (guidelines/repository-commands.md).
rem Humans only. Agents must never run Deploy Prod.
setlocal
cd /d "%~dp0"
node "%~dp0actions\DeployProd.mjs" %*
if errorlevel 1 (
  if not defined AC_NO_PAUSE pause
  exit /b 1
)
exit /b 0
