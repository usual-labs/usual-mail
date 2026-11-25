#!/bin/zsh
# Makes the onboarding tour's clips (Packages/UsualMailUI/Sources/UsualMailUI/Resources/tour-*.mp4), one a slide of
# "While your mail comes in": builds a copy of the Mac app under its own bundle ID (labs.usual.preview, so the real
# app and its data are never touched), opens it on the tour's sample (`-UsualMailTour YES`) in each state a clip shows,
# captures its window alone, then composes each clip from tour/clips/<n>-<name>.json (scripts/tour/compose.swift: a
# drawn pointer, clicks, crossfades, zooms) and encodes it with ffmpeg (H.264). The app's windows open and close on
# screen while it runs; leave the Mac alone for a minute. Needs Xcode and ffmpeg. Check the clips by eye.
# Usage: scripts/make-tour.sh [scratch folder]
set -eu
cd "$(dirname "$0")/.."
work=${1:-build/Tour}
mkdir -p "$work/captures"
out=Packages/UsualMailUI/Sources/UsualMailUI/Resources

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

for clip in scripts/tour/clips/*.json; do
    name=$(basename "$clip" .json)
    swift scripts/tour/compose.swift "$clip" "$work/captures" |
        ffmpeg -hide_banner -loglevel error -y -f rawvideo -pix_fmt bgra -s 1280x832 -r 30 -i - \
            -c:v libx264 -preset slow -crf 24 -tune animation -pix_fmt yuv420p -movflags +faststart -an \
            "$out/tour-$name.mp4"
    echo "made tour-$name.mp4"
done
