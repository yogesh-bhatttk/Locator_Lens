#!/bin/bash
# Prepare the extension for loading unpacked during development.
#
# This script never rewrites tracked files. The root manifest.json is always the
# Chrome manifest, so Chrome can load the repository root directly; Firefox needs
# its own manifest, so it loads the built tree in dist/firefox/ instead.
set -euo pipefail
cd "$(dirname "$0")"

TYPE="${1:-}"

if [ "$TYPE" == "chrome" ]; then
    if ! cmp -s manifest.json manifests/manifest.chrome.json; then
        # Only reachable from a tree an older setup.sh modified: put the tracked
        # Chrome manifest back rather than leaving the root pointing at Firefox.
        cp manifests/manifest.chrome.json manifest.json
        echo "[Locatra] Restored the root manifest.json to the Chrome manifest."
    fi
    echo "---------------------------------------------------"
    echo "[Locatra] Chrome / Edge / Brave"
    echo "chrome://extensions -> Developer mode -> Load unpacked -> this folder"
    echo "(or run 'npm run build' and load dist/chrome)"
    echo "---------------------------------------------------"
elif [ "$TYPE" == "firefox" ]; then
    node scripts/build.mjs firefox
    echo "---------------------------------------------------"
    echo "[Locatra] Firefox"
    echo "about:debugging#/runtime/this-firefox -> Load Temporary Add-on ->"
    echo "  $(pwd)/dist/firefox/manifest.json"
    echo "Re-run this after editing src/ to refresh dist/firefox."
    echo "---------------------------------------------------"
else
    echo ""
    echo "[Locatra] Setup Usage:"
    echo "./setup.sh chrome    - Load the repository root in Chrome/Edge/Brave"
    echo "./setup.sh firefox   - Build dist/firefox and load it in Firefox"
    echo ""
fi
