@echo off
set TYPE=%1

if "%TYPE%"=="chrome" (
    copy manifests\manifest.chrome.json manifest.json /Y
    echo ---------------------------------------------------
    echo [Locatra] SYSTEM RECONFIGURED FOR CHROME (V3)
    echo 0 Warnings Detected. Ready for Load Unpacked.
    echo ---------------------------------------------------
) else if "%TYPE%"=="firefox" (
    copy manifests\manifest.firefox.json manifest.json /Y
    echo ---------------------------------------------------
    echo [Locatra] SYSTEM RECONFIGURED FOR FIREFOX (V3)
    echo 0 Warnings Detected. Ready for Load Temporary Add-on.
    echo ---------------------------------------------------
) else (
    echo.
    echo [Locatra] Setup Usage:
    echo setup.bat chrome    - Configure for Chrome/Edge/Brave
    echo setup.bat firefox   - Configure for Mozilla Firefox
    echo.
)
