#!/bin/sh
# Archives the iPhone app, or with --mac the Mac app (Release), and uploads it to TestFlight, for internal testing
# only. Both are one App Store Connect record (the same bundle ID): a Mac given the Mac build installs that from
# TestFlight instead of running the iPhone build in a phone-sized window.
#
# Xcode signs with the team's own certificates and profiles, which it makes itself: sign in to the team under
# Xcode › Settings › Accounts first. App Store Connect must already have an app record for the bundle ID
# (<prefix>.UsualMail); the upload is refused without one. --mac's first upload was accepted (2026-11-25) though the
# record then had only the iOS platform.
#
# Usage: DEVELOPMENT_TEAM=ABCDE12345 scripts/testflight.sh [--mac] [--check]
#   --mac     the Mac app instead of the iPhone app
#   --check   signs and exports into build/TestFlight without uploading
#
# BUNDLE_ID_PREFIX (default labs.usual) is the reverse-DNS prefix of the bundle ID.
set -eu
cd "$(dirname "$0")/.."

destination=upload
platform=iphone
for option in "$@"; do
    case "$option" in
    --check) destination=export ;;
    --mac) platform=mac ;;
    *) echo "Pick --mac, --check, both or neither, not $option." >&2; exit 64 ;;
    esac
done
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

if [ "$platform" = mac ]; then
    echo "Usual Mail $version ($build) for the Mac"
    scheme=UsualMail
    generic='generic/platform=macOS'
else
    echo "Usual Mail $version ($build) for iPhone"
    scheme=UsualMailPhone
    generic='generic/platform=iOS'
fi
archive="$out/UsualMail-$platform.xcarchive"
rm -rf "$archive" "${out:?}/$platform"
# Local.xcconfig may pin the Mac's Debug signing; the archive is signed automatically, whatever it says.
xcodebuild archive -quiet -project UsualMail.xcodeproj -scheme "$scheme" -configuration Release \
    -destination "$generic" -archivePath "$archive" -allowProvisioningUpdates \
    CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
    DEVELOPMENT_TEAM="$team" BUNDLE_ID_PREFIX="$prefix" \
    MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build"
xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/$platform" \
    -exportOptionsPlist "$options" -allowProvisioningUpdates
