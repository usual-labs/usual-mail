import AVFoundation
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// One slide's clip in "While your mail comes in" (the owner's words of 2026-11-25: "use dummy data to show properly
/// the features, and even show a cursor animating … with a gif/video instead of image"): the app on the tour's sample,
/// a few seconds long, looping. Each app shows its own ("in iphone, the videos should show the iphone UI not mac UI!",
/// the same day): the Mac's window with a drawn pointer moving and clicking, the iPhone's screen with a touch where the
/// finger lands. Made by `apps/scripts/make-tour.sh`, in this package's resources as `tour-mac-<n>-<name>.mp4` (H.264,
/// 1280 × 832) and `tour-phone-<n>-<name>.mp4` (600 × 1304), silent.
struct TourClip: Equatable {
    /// The resource's name, without `.mp4`.
    let resource: String
    /// When the clip shows its feature, in seconds: the still shown instead with Reduce Motion on.
    let still: Double

    /// The Mac's clips' frame: its captured window's proportions (1512 × 982 points).
    static let macAspect: CGFloat = 1280 / 832
    /// The iPhone's: its screen's (402 × 874 points).
    static let phoneAspect: CGFloat = 600 / 1304

    /// The Mac's, one a slide, in `Onboarding.slides`' order.
    static let mac: [TourClip] = [
        TourClip(resource: "tour-mac-1-home", still: 3.0),
        TourClip(resource: "tour-mac-2-lines", still: 2.6),
        TourClip(resource: "tour-mac-3-feed", still: 3.2),
        TourClip(resource: "tour-mac-4-receipts", still: 3.2),
        TourClip(resource: "tour-mac-5-notifications", still: 3.2),
        TourClip(resource: "tour-mac-6-lists", still: 3.0),
        TourClip(resource: "tour-mac-7-screening", still: 3.2),
        TourClip(resource: "tour-mac-8-inbox", still: 3.6),
        TourClip(resource: "tour-mac-9-inboxes", still: 2.8),
    ]

    /// The iPhone's, the same way. The lists and the inboxes are in the switcher's menu there, so their stills show it
    /// open.
    static let phone: [TourClip] = [
        TourClip(resource: "tour-phone-1-home", still: 3.0),
        TourClip(resource: "tour-phone-2-lines", still: 0.3),
        TourClip(resource: "tour-phone-3-feed", still: 3.0),
        TourClip(resource: "tour-phone-4-receipts", still: 3.0),
        TourClip(resource: "tour-phone-5-notifications", still: 3.0),
        TourClip(resource: "tour-phone-6-lists", still: 2.3),
        TourClip(resource: "tour-phone-7-screening", still: 3.0),
        TourClip(resource: "tour-phone-8-inbox", still: 4.5),
        TourClip(resource: "tour-phone-9-inboxes", still: 2.2),
    ]

    /// This app's clips and their proportions.
    #if os(iOS)
        static let all = phone
        static let aspect = phoneAspect
    #else
        static let all = mac
        static let aspect = macAspect
    #endif

    var url: URL? { Icon.bundle.url(forResource: resource, withExtension: "mp4") }
}

/// A clip playing silently on a loop, or held at its still with Reduce Motion on. Nothing shows when it can't load.
struct TourClipView: View {
    let clip: TourClip
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ClipPlayerView(url: clip.url, still: reduceMotion ? clip.still : nil)
            .aspectRatio(TourClip.aspect, contentMode: .fit)
    }
}

/// The player behind a clip: a queue player and its looper, or one item held at a time.
@MainActor
final class ClipPlayer {
    let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?
    private var shown: (url: URL?, still: Double?)?

    init() {
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        #if os(iOS)
            player.allowsExternalPlayback = false
        #endif
    }

    /// Plays `url` on a loop, or holds it at `still` seconds; the same twice changes nothing.
    func show(_ url: URL?, still: Double?) {
        if let shown, shown.url == url, shown.still == still { return }
        shown = (url, still)
        looper?.disableLooping()
        looper = nil
        player.removeAllItems()
        guard let url else { return }
        let item = AVPlayerItem(url: url)
        if let still {
            player.insert(item, after: nil)
            player.seek(
                to: CMTime(seconds: still, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            player.pause()
        } else {
            looper = AVPlayerLooper(player: player, templateItem: item)
            player.play()
        }
    }

    func stop() {
        looper?.disableLooping()
        looper = nil
        player.pause()
        player.removeAllItems()
    }
}

#if os(macOS)
    /// An `AVPlayerLayer` in a view, on the Mac.
    struct ClipPlayerView: NSViewRepresentable {
        let url: URL?
        let still: Double?

        func makeNSView(context: Context) -> PlayerLayerView { PlayerLayerView() }

        func updateNSView(_ view: PlayerLayerView, context: Context) {
            view.clip.show(url, still: still)
        }

        static func dismantleNSView(_ view: PlayerLayerView, coordinator: ()) {
            view.clip.stop()
        }

        final class PlayerLayerView: NSView {
            let clip = ClipPlayer()
            private let playerLayer = AVPlayerLayer()

            override init(frame: NSRect) {
                super.init(frame: frame)
                wantsLayer = true
                playerLayer.player = clip.player
                playerLayer.videoGravity = .resizeAspect
                layer?.addSublayer(playerLayer)
            }

            required init?(coder: NSCoder) { nil }

            override func layout() {
                super.layout()
                playerLayer.frame = bounds
            }
        }
    }
#else
    /// An `AVPlayerLayer` as a view's own layer, on the iPhone.
    struct ClipPlayerView: UIViewRepresentable {
        let url: URL?
        let still: Double?

        func makeUIView(context: Context) -> PlayerLayerView { PlayerLayerView() }

        func updateUIView(_ view: PlayerLayerView, context: Context) {
            view.clip.show(url, still: still)
        }

        static func dismantleUIView(_ view: PlayerLayerView, coordinator: ()) {
            view.clip.stop()
        }

        final class PlayerLayerView: UIView {
            let clip = ClipPlayer()

            override class var layerClass: AnyClass { AVPlayerLayer.self }

            override init(frame: CGRect) {
                super.init(frame: frame)
                let playerLayer = layer as! AVPlayerLayer
                playerLayer.player = clip.player
                playerLayer.videoGravity = .resizeAspect
            }

            required init?(coder: NSCoder) { nil }
        }
    }
#endif
