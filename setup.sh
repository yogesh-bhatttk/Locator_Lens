#!/bin/bash
TYPE=$1

if [ "$TYPE" == "chrome" ]; then
    cp manifests/manifest.chrome.json manifest.json
    echo "---------------------------------------------------"
    echo "[LocatorLens] SYSTEM RECONFIGURED FOR CHROME (V3)"
    echo "0 Warnings Detected. Ready for Load Unpacked."
    echo "---------------------------------------------------"
elif [ "$TYPE" == "firefox" ]; then
    cp manifests/manifest.firefox.json manifest.json
    echo "---------------------------------------------------"
    echo "[LocatorLens] SYSTEM RECONFIGURED FOR FIREFOX (V3)"
    echo "0 Warnings Detected. Ready for Load Temporary Add-on."
    echo "---------------------------------------------------"
else
    echo ""
    echo "[LocatorLens] Setup Usage:"
    echo "./setup.sh chrome    - Configure for Chrome/Edge/Brave"
    echo "./setup.sh firefox   - Configure for Mozilla Firefox"
    echo ""
fi
