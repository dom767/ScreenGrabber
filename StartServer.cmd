@echo off
rem Start this app's local static preview (guidelines/start-scripts.md).
rem ScreenGrabber has no local API runner; this serves the working tree (SDK, docs).
rem Uses %PORT% if set (agents), otherwise 8092.
setlocal
cd /d "%~dp0"

if not defined PORT set "PORT=8092"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to run the local preview. Install the LTS version from https://nodejs.org and try again.
  if not defined AC_NO_PAUSE pause
  exit /b 1
)

echo Serving %CD% on http://127.0.0.1:%PORT%/
echo ScreenGrabber API runs only on AWS Lambda; this window is a static preview of the repo.
echo Close this window or press Ctrl+C to stop.
call npx --yes serve -l tcp://127.0.0.1:%PORT% .
if errorlevel 1 (
  echo The local server could not start. See the error above.
  if not defined AC_NO_PAUSE pause
  exit /b 1
)
exit /b 0
