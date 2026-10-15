@echo off
where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  py -3 "%USERPROFILE%\.gemini\config\skills\argon\scripts\gemini_argon_bridge.py" %*
) else (
  python "%USERPROFILE%\.gemini\config\skills\argon\scripts\gemini_argon_bridge.py" %*
)
exit /b %ERRORLEVEL%
