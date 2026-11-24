#!/bin/sh
# Builds the Mac app (Debug) signed with this Mac's "Apple Development" certificate and opens it.
# Every build then has the same signature, so after one "Always Allow" the Keychain stops asking for the login
# password on each rebuild (ad hoc builds got a new signature each time).
# Usage: scripts/run-mac.sh [derived-data-path]   (default: build/DerivedData under apps/)
set -eu
cd "$(dirname "$0")/.."
DERIVED=${1:-build/DerivedData}
TEAM=$(security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject -nameopt multiline \
    | awk -F'= ' '/organizationalUnitName/{print $2}')
[ -n "$TEAM" ] || { echo "No Apple Development certificate in the keychain." >&2; exit 1; }
xcodebuild build -quiet -project UsualMail.xcodeproj -scheme UsualMail -configuration Debug \
    -destination 'platform=macOS' -derivedDataPath "$DERIVED" \
    CODE_SIGN_IDENTITY="Apple Development" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$TEAM"
pkill -TERM -f "UsualMail.app/Contents/MacOS/UsualMail" 2>/dev/null || true
sleep 1
open "$DERIVED/Build/Products/Debug/UsualMail.app"
