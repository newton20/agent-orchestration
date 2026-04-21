@echo off
REM Unit 4.5 SessionStart hook wrapper.
REM Claude Code invokes this .cmd via hooks.json; we hand off to node so
REM the spike runs on any Windows box with Node on PATH (same dependency
REM the rest of the plugin already assumes). stdin from Claude Code is
REM piped through the .cmd into the node process unchanged.
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%..\hook-env-spike.js"
exit /b %ERRORLEVEL%
