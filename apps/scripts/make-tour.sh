#!/bin/zsh
# Makes the onboarding tour's clips, one a slide of "While your mail comes in", for the Mac app (tour-mac-*.mp4) or
# the iPhone app (tour-phone-*.mp4) in Packages/UsualMailUI/Sources/UsualMailUI/Resources. Each app plays its own.
# It builds a copy of the app under its own bundle ID (labs.usual.preview, so the real app and its data are never
# touched), opens it on the tour's sample (`-UsualMailTour YES`) in each state a clip shows, captures it, then composes
# each clip from tour/clips/<platform>/<n>-<name>.json (scripts/tour/compose.swift: a drawn pointer or touch, taps,
# crossfades, zooms) and encodes it with ffmpeg (H.264). Needs Xcode and ffmpeg. Check the clips by eye.
#
# mac: the app's windows open and close on screen while it runs; leave the Mac alone for a minute.
# phone: needs a booted iPhone simulator 402 points wide (an iPhone 17 or 18 Pro) and agent-device to open the app,
# tap its switcher and take screenshots. AGENT_DEVICE is how to run it (default `agent-device`, with whatever flags pick
# the simulator); SIMULATOR is the simulator's UDID (default: the booted one), whose status bar shows 9:41 meanwhile
# and is given back after.
#
# Usage: scripts/make-tour.sh mac|phone [scratch folder]
set -eu
cd "$(dirname "$0")/.."
platform=${1:?Say mac or phone.}
work=${2:-build/Tour/$platform}
mkdir -p "$work/captures"
out=Packages/UsualMailUI/Sources/UsualMailUI/Resources

if [ "$platform" = mac ]; then
    size=1280x832
    xcodebuild build -quiet -project UsualMail.xcodeproj -scheme UsualMail -configuration Debug \
        -destination 'platform=macOS' -derivedDataPath "$work/DerivedData" BUNDLE_ID_PREFIX=labs.usual.preview
    app="$work/DerivedData/Build/Products/Debug/UsualMail.app"
    binary="$app/Contents/MacOS/UsualMail"

    # capture <state> [launch options…]: the app opened at 1512 x 982 in that state, its window captured alone.
    capture() {
        local state=$1
        shift
        pkill -f "$binary" 2>/dev/null || true
        sleep 0.5
        open -n "$app" --args -UsualMailTour YES -UsualMailWindowSize 1512x982 "$@"
        sleep 4
        local pid window
        pid=$(pgrep -f "$binary" | head -n 1)
        window=$(swift scripts/tour/window-id.swift "$pid")
        screencapture -x -o -l "$window" "$work/captures/$state.png"
        echo "captured $state"
    }

    capture home -UsualMailPlace home
    capture mail -UsualMailPlace home -UsualMailThread thr_1
    capture reads -UsualMailPlace reads
    capture receipts -UsualMailPlace receipts
    capture notifications -UsualMailPlace notifications
    capture reply -UsualMailPlace reply
    capture pinned -UsualMailPlace pinned
    capture snoozed -UsualMailPlace snoozed
    capture screening -UsualMailPlace screening
    capture inbox -UsualMailPlace inbox
    capture rail -UsualMailPlace home -UsualMailRailOpen YES
    capture rail-northwind -UsualMailPlace home -UsualMailRailOpen YES -UsualMailInbox inb_northwind
    capture rail-personal -UsualMailPlace home -UsualMailRailOpen YES -UsualMailInbox inb_personal
    pkill -f "$binary" 2>/dev/null || true
elif [ "$platform" = phone ]; then
    size=600x1304
    device=(${=AGENT_DEVICE:-agent-device})
    simulator=${SIMULATOR:-booted}
    bundle=labs.usual.preview.UsualMail
    xcodebuild build -quiet -project UsualMail.xcodeproj -scheme UsualMailPhone -configuration Debug \
        -destination 'generic/platform=iOS Simulator' -derivedDataPath "$work/DerivedData" \
        BUNDLE_ID_PREFIX=labs.usual.preview
    "${device[@]}" install "$bundle" "$work/DerivedData/Build/Products/Debug-iphonesimulator/UsualMail.app" >/dev/null
    xcrun simctl status_bar "$simulator" override --time 9:41 --batteryState discharging --batteryLevel 100 \
        --wifiBars 3 --cellularMode active --cellularBars 4
    trap 'xcrun simctl status_bar "$simulator" clear' EXIT

    # capture <state> [menu] [launch options…]: the app opened in that state (with `menu`, its switcher's menu open
    # over it), the screen captured at the simulator's own 3x.
    capture() {
        local state=$1
        shift
        local menu=no
        if [ "${1:-}" = menu ]; then
            menu=yes
            shift
        fi
        local launch=()
        for option in -UsualMailTour YES "$@"; do launch+=(--launch-args "$option"); done
        "${device[@]}" open "$bundle" --relaunch "${launch[@]}" >/dev/null
        sleep 4
        if [ "$menu" = yes ]; then
            # The switcher, in the middle of the top row.
            "${device[@]}" press 201 84 >/dev/null
            sleep 1.5
        fi
        "${device[@]}" screenshot "$work/captures/$state.png" --pixel-density 3 >/dev/null
        echo "captured $state"
    }

    capture home -UsualMailPlace home
    capture mail -UsualMailPlace home -UsualMailThread thr_1
    capture reads -UsualMailPlace reads
    capture receipts -UsualMailPlace receipts
    capture notifications -UsualMailPlace notifications
    capture screening -UsualMailPlace screening
    capture reply -UsualMailPlace reply
    capture pinned -UsualMailPlace pinned
    capture inbox -UsualMailPlace inbox
    capture northwind -UsualMailPlace home -UsualMailInbox inb_northwind
    capture personal -UsualMailPlace home -UsualMailInbox inb_personal
    capture menu menu -UsualMailPlace home
    capture menu-reply menu -UsualMailPlace reply
    capture menu-northwind menu -UsualMailPlace home -UsualMailInbox inb_northwind
else
    echo "Say mac or phone, not $platform." >&2
    exit 64
fi

for clip in scripts/tour/clips/$platform/*.json; do
    name=$(basename "$clip" .json)
    swift scripts/tour/compose.swift "$clip" "$work/captures" |
        ffmpeg -hide_banner -loglevel error -y -f rawvideo -pix_fmt bgra -s "$size" -r 30 -i - \
            -c:v libx264 -preset slow -crf 24 -tune animation -pix_fmt yuv420p -movflags +faststart -an \
            "$out/tour-$platform-$name.mp4"
    echo "made tour-$platform-$name.mp4"
done
