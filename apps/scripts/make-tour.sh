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
# tap its switcher and take screenshots (scripts/tour/capture-phone.zsh). AGENT_DEVICE is how to run agent-device
# (default `agent-device`); SIMULATOR is the simulator's UDID, needed when more than one is booted. agent-device is
# pointed at that simulator, whose status bar shows 9:41 meanwhile and is given back however the capture ends.
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
    # The simulator: SIMULATOR's UDID, or the one booted; agent-device and the status bar both use it.
    booted=(${(f)"$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p')"})
    if [ -n "${SIMULATOR:-}" ]; then
        simulator=$SIMULATOR
        if (( ! ${booted[(Ie)$simulator]} )); then
            echo "No booted simulator has the UDID $simulator." >&2
            exit 64
        fi
    elif [ ${#booted} -eq 1 ]; then
        simulator=${booted[1]}
    else
        echo "Boot one iPhone simulator, or set SIMULATOR to the UDID of the one to use (${#booted} are booted)." >&2
        exit 64
    fi
    device=(${=AGENT_DEVICE:-agent-device})
    xcodebuild build -quiet -project UsualMail.xcodeproj -scheme UsualMailPhone -configuration Debug \
        -destination "id=$simulator" -derivedDataPath "$work/DerivedData" BUNDLE_ID_PREFIX=labs.usual.preview
    "${device[@]}" install labs.usual.preview.UsualMail \
        "$work/DerivedData/Build/Products/Debug-iphonesimulator/UsualMail.app" --platform ios --udid "$simulator" \
        >/dev/null

    # The status bar shows 9:41 while the states are captured, and is given back however the capture ends: it runs in
    # its own zsh (known-issues.md: zsh skips the EXIT trap when `set -e` stops a function), a signal here exits
    # through the EXIT trap, and `captured` isn't `status`, which zsh keeps read-only.
    trap 'xcrun simctl status_bar "$simulator" clear' EXIT
    trap 'exit 130' INT TERM HUP
    xcrun simctl status_bar "$simulator" override --time 9:41 --batteryState discharging --batteryLevel 100 \
        --wifiBars 3 --cellularMode active --cellularBars 4
    captured=0
    zsh -eu scripts/tour/capture-phone.zsh "$work/captures" "$simulator" "${device[@]}" || captured=$?
    [ "$captured" = 0 ] || exit "$captured"
    xcrun simctl status_bar "$simulator" clear
    trap - EXIT INT TERM HUP
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
