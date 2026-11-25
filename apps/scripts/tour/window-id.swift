// Prints the window number of the process `pid`'s first ordinary window on screen, for `screencapture -l`, which then
// captures that window alone (apps/scripts/make-tour.sh).
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("Usage: swift window-id.swift <pid>\n".data(using: .utf8)!)
    exit(64)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows
where (window[kCGWindowOwnerPID as String] as? Int) == pid && (window[kCGWindowLayer as String] as? Int) == 0 {
    print(window[kCGWindowNumber as String]!)
    exit(0)
}
exit(1)
