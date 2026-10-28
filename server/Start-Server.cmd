@echo off
rem ===========================================================================
rem  Start-Server.cmd  --  double-click to start the account server.
rem
rem  ASCII-only on purpose (same reason as client\Start-Mimitale.cmd): cmd.exe
rem  re-reads this file using the active code page, so non-ASCII bytes can be
rem  mis-parsed into a bogus "file not found" on some later line.
rem
rem  This only fixes PATH, then hands over to `npm run dev` (scripts/dev.mjs):
rem  docker db + mail -> wait for Postgres -> migrate -> seed -> watch.
rem ===========================================================================

cd /d "%~dp0"
title Mimitale Server

rem --- cmd started from a stripped environment may not have ProgramFiles ---
if not defined ProgramFiles set "ProgramFiles=C:\Program Files"

rem --- Node.js: the installer does not always end up on PATH ---
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto :nonode
where npm >nul 2>nul
if errorlevel 1 goto :nonpm

rem --- Docker Desktop: bin and the compose plugin are often missing from PATH ---
if exist "%ProgramFiles%\Docker\Docker\resources\bin" set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
if exist "%ProgramFiles%\Docker\cli-plugins" set "PATH=%ProgramFiles%\Docker\cli-plugins;%PATH%"

if not exist "node_modules" (
  echo First run: installing dependencies, this takes a while ...
  call npm install
  if errorlevel 1 goto :fail
)

call npm run dev

echo.
echo Server stopped.
pause
exit /b 0

:nonode
echo ==========================================================
echo  [ERROR] Node.js was not found.
echo.
echo  Install the LTS version from https://nodejs.org
echo  Keep the default options, restart, then run this again.
echo ==========================================================
echo.
pause
exit /b 1

:nonpm
echo ==========================================================
echo  [ERROR] node was found, but npm was not.
echo  Your Node.js install looks incomplete. Please reinstall it.
echo ==========================================================
echo.
pause
exit /b 1

:fail
echo ==========================================================
echo  [ERROR] Could not install dependencies.
echo  Open a command prompt in this folder and run manually:
echo      npm install
echo ==========================================================
echo.
pause
exit /b 1
