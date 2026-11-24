#!/bin/sh
# Archives the iPhone app (Release) and uploads it to TestFlight, for internal testing only.
#
# Xcode signs with the team's own certificates and profiles, which it makes itself: sign in to the team under
# Xcode › Settings › Accounts first. App Store Connect must already have an app record for the bundle ID
# (<prefix>.UsualMail); the upload is refused without one.
#
# Usage: DEVELOPMENT_TEAM=ABCDE12345 scripts/testflight.sh [--check]
#   --check   signs and exports into build/TestFlight without uploading
#
# BUNDLE_ID_PREFIX (default labs.usual) is the reverse-DNS prefix of the bundle ID.
set -eu
cd "$(dirname "$0")/.."

destination=upload
if [ "${1:-}" = --check ]; then
    destination=export
    shift
fi
[ $# -eq 0 ] || { echo "Pick --check or nothing, not $1." >&2; exit 64; }
team="${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to your team ID.}"
prefix="${BUNDLE_ID_PREFIX:-labs.usual}"
version=$(sed -n 's/^MARKETING_VERSION = //p' Config/Shared.xcconfig)
# TestFlight wants a larger build number on every upload; the time gives one.
build=$(date -u +%Y%m%d%H%M)
out=build/TestFlight
mkdir -p "$out"

options="$out/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "Usual Mail $version ($build) for iPhone"
archive="$out/UsualMail-iphone.xcarchive"
rm -rf "$archive" "$out/iphone"
# Local.xcconfig may pin the Mac's Debug signing; the archive is signed automatically, whatever it says.
xcodebuild archive -quiet -project UsualMail.xcodeproj -scheme UsualMailPhone -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive" -allowProvisioningUpdates \
    CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
    DEVELOPMENT_TEAM="$team" BUNDLE_ID_PREFIX="$prefix" \
    MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build"
xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/iphone" \
    -exportOptionsPlist "$options" -allowProvisioningUpdates
