@echo off
if not defined AGENT_ORCHESTRATOR_ATTEMPT exit /b 0
if not defined AGENT_ORCHESTRATOR_NODE (
  echo [attempt-observation] Missing pinned Node executable. 1>&2
  exit /b 1
)
"%AGENT_ORCHESTRATOR_NODE%" "%~dp0claude-observation.js" %1
