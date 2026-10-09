@echo off
rem Prepare the extension for loading unpacked during development.
rem
rem This script never rewrites tracked files. The root manifest.json is always the
rem Chrome manifest, so Chrome can load the repository root directly; Firefox needs
rem its own manifest, so it loads the built tree in dist\firefox\ instead.
setlocal
cd /d "%~dp0"
set TYPE=%1

if "%TYPE%"=="chrome" (
    fc /b manifest.json manifests\manifest.chrome.json >nul 2>&1 || (
        copy manifests\manifest.chrome.json manifest.json /Y >nul
        echo [Locatra] Restored the root manifest.json to the Chrome manifest.
    )
    echo ---------------------------------------------------
    echo [Locatra] Chrome / Edge / Brave
    echo chrome://extensions - Developer mode - Load unpacked - this folder
    echo ^(or run "npm run build" and load dist\chrome^)
    echo ---------------------------------------------------
) else if "%TYPE%"=="firefox" (
    node scripts\build.mjs firefox || exit /b 1
    echo ---------------------------------------------------
    echo [Locatra] Firefox
    echo about:debugging#/runtime/this-firefox - Load Temporary Add-on -
    echo   %CD%\dist\firefox\manifest.json
    echo Re-run this after editing src\ to refresh dist\firefox.
    echo ---------------------------------------------------
) else (
    echo.
    echo [Locatra] Setup Usage:
    echo setup.bat chrome    - Load the repository root in Chrome/Edge/Brave
    echo setup.bat firefox   - Build dist\firefox and load it in Firefox
    echo.
)
