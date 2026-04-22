@echo off
REM Unit 5 SessionStart hook — Windows wrapper. Claude Code on Windows
REM executes hook commands through Git Bash; bash can exec .cmd files,
REM so this wrapper stays compatible with both shells. %~dp0 pins the
REM script dir so we don't depend on cwd at hook invocation time.
node "%~dp0session-start.js"
