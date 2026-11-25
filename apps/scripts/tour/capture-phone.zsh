# Captures the iPhone states of the onboarding tour's clips (make-tour.sh phone runs it with `zsh -eu`): the preview
# copy opened in each state on the tour's sample, the screen taken at the simulator's own 3x. It runs in its own zsh so
# that whatever stops it, make-tour.sh still gives the simulator's status bar back (known-issues.md: under `set -e`, a
# failure inside a function skips zsh's EXIT trap).
#
# Usage: zsh -eu scripts/tour/capture-phone.zsh <captures folder> <simulator UDID> <agent-device command…>
captures=$1
simulator=$2
shift 2
device=("$@")
bundle=labs.usual.preview.UsualMail

# agent-device on the simulator make-tour.sh chose, the one whose status bar it set.
run() {
    "${device[@]}" "$@" --platform ios --udid "$simulator" >/dev/null
}

# capture <state> [menu] [launch options…]: the app opened in that state (with `menu`, its switcher's menu open over
# it), the screen captured at 3x.
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
    run open "$bundle" --relaunch "${launch[@]}"
    sleep 4
    if [ "$menu" = yes ]; then
        # The switcher, in the middle of the top row.
        run press 201 84
        sleep 1.5
    fi
    run screenshot "$captures/$state.png" --pixel-density 3
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
