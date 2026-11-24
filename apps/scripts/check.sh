#!/bin/sh
# The apps' checks: formatting, both packages' tests (which include the check that UsualMailKit's copy
# of core/fixtures/sample.json is current) and unsigned builds of the Mac app and the iPhone app (for
# the simulator). The tests run on the Mac only.
# Nothing is launched. Keep the Mac unlocked: one test writes to the login Keychain and deletes it again.
#
# Usage: scripts/check.sh [--fast | macos | ios]
#   (nothing)  everything
#   --fast     everything but the app builds
#   macos      only the Mac app's build
#   ios        only the iPhone app's build
set -eu
cd "$(dirname "$0")/.."

checks() {
    swift format lint --strict --recursive App AppPhone \
        Packages/UsualMailKit/Package.swift Packages/UsualMailKit/Sources Packages/UsualMailKit/Tests \
        Packages/UsualMailUI/Package.swift Packages/UsualMailUI/Sources Packages/UsualMailUI/Tests
    swift test --package-path Packages/UsualMailKit
    swift test --package-path Packages/UsualMailUI
}

# build <scheme> <platform>
build() {
    xcodebuild build -quiet -project UsualMail.xcodeproj -scheme "$1" \
        -destination "generic/platform=$2" CODE_SIGNING_ALLOWED=NO
}

case "${1:-}" in
    '') checks; build UsualMail macOS; build UsualMailPhone 'iOS Simulator' ;;
    --fast) checks ;;
    macos) build UsualMail macOS ;;
    ios) build UsualMailPhone 'iOS Simulator' ;;
    *) echo "Pick --fast, macos or ios, not $1." >&2; exit 64 ;;
esac
