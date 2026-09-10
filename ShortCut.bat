@echo off
title ShortCut
cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo First run - installing dependencies. This takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Make sure Node.js is installed: https://nodejs.org
    pause
    exit /b 1
  )
)

rem A .scut path passed to this script opens on launch, skipping the file dialog:
rem   ShortCut.bat project_test_2.scut
start "" /b cmd /c "node_modules\.bin\electron.cmd" . %*
exit /b 0
