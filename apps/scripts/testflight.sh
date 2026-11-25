#!/bin/sh
# Archives the iPhone app, or with --mac the Mac app (Release), and uploads it to TestFlight, for internal testing
# only. Both are one App Store Connect record (the same bundle ID): a Mac given the Mac build installs that from
# TestFlight instead of running the iPhone build in a phone-sized window.
#
# Xcode signs with the team's own certificates and profiles, which it makes itself: sign in to the team under
# Xcode › Settings › Accounts first. App Store Connect must already have an app record for the bundle ID
# (<prefix>.UsualMail); the upload is refused without one. A record with only the iOS platform takes --mac's builds
# too: App Store Connect adds the macOS version itself (2026-11-25).
#
# Usage: DEVELOPMENT_TEAM=ABCDE12345 scripts/testflight.sh [--mac] [--check]
#   --mac     the Mac app instead of the iPhone app
#   --check   signs and exports into build/TestFlight without uploading (with --mac, then checks every signature
#             in the package's app is the app's own: each sealed bundle and each Mach-O file)
#
# Run `--mac --check` before `--mac`: App Store Connect checks the Mac package's signatures only after the upload,
# and the check here catches what it would refuse. Either registers a build number with App Store Connect (an export
# with cloud-managed signing announces it), so neither is run just to try the script.
#
# BUNDLE_ID_PREFIX (default labs.usual) is the reverse-DNS prefix of the bundle ID.
set -eu
cd "$(dirname "$0")/.."

# Every Mach-O file (an executable, a library, a loadable bundle's code) under $1, one path a line, by what `file`
# reads in it rather than by where it sits.
machos() {
    find "$1" -type f | while IFS= read -r file; do
        case "$(file -b "$file")" in *Mach-O*) printf '%s\n' "$file" ;; esac
    done
}

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

if [ "$platform" = mac ]; then
    # Xcode signs each Swift package's resource bundle (Contents/Resources/*.bundle) with the archive's development
    # certificate, and the App Store export re-signs only the app and code in the usual places (Frameworks, PlugIns
    # and the like), never bundles under Resources: App Store Connect refuses those (ITMS-90284, 2026-11-25). They hold
    # no code, so their own signatures come off and the export's signature of the app seals them as plain resources.
    for bundle in "$archive"/Products/Applications/UsualMail.app/Contents/Resources/*.bundle; do
        [ -d "$bundle" ] || continue
        if [ -e "$bundle/Contents/MacOS" ] ||
            /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist" >/dev/null 2>&1 ||
            [ -n "$(machos "$bundle")" ]; then
            echo "$bundle holds code, so its signature can't simply come off." >&2
            exit 1
        fi
        rm -rf "$bundle/Contents/_CodeSignature"
    done
fi

xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/$platform" \
    -exportOptionsPlist "$options" -allowProvisioningUpdates

if [ "$platform" = mac ] && [ "$destination" = export ]; then
    # Every signature in the exported app must be the app's own (App Store Connect checks this only after the upload;
    # codesign --verify --deep doesn't look into bundles under Resources).
    expanded="$out/mac/expanded"
    pkgutil --expand-full "$out/mac/UsualMail.pkg" "$expanded"
    app=$(find "$expanded" -maxdepth 3 -type d -name UsualMail.app | head -n 1)
    codesign --verify --deep --strict "$app"
    signer() { codesign -dvv "$1" 2>&1 | sed -n 's/^Authority=//p' | head -n 1; }
    want=$(signer "$app")
    echo "The app is signed by $want."
    find "$app" -type d -name _CodeSignature | while read -r seal; do
        item=$(dirname "$seal")
        [ "$(basename "$item")" = Contents ] && item=$(dirname "$item")
        got=$(signer "$item")
        [ "$got" = "$want" ] || { echo "${item#"$app"/} is signed by ${got:-nobody}, not $want." >&2; exit 1; }
    done
    # Code wherever it sits, not only in sealed bundles: a Mach-O file under Resources has no _CodeSignature folder.
    machos "$app" | while IFS= read -r binary; do
        got=$(signer "$binary")
        [ "$got" = "$want" ] || { echo "${binary#"$app"/} is code signed by ${got:-nobody}, not $want." >&2; exit 1; }
    done
    rm -rf "$expanded"
fi
