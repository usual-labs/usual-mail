import SwiftUI
import Testing

@testable import UsualMailDesign

/// Resolving a colour backed by a dynamic NSColor off the main thread hung in testing, so these run on the main actor.
@MainActor @Suite struct ColorTests {
    private func resolved(_ color: Color, _ scheme: ColorScheme) -> UsualRGB {
        var environment = EnvironmentValues()
        environment.colorScheme = scheme
        let c = color.resolve(in: environment)
        func byte(_ v: Float) -> UInt32 { UInt32((Double(v) * 255).rounded()) }
        return UsualRGB((byte(c.red) << 16) | (byte(c.green) << 8) | byte(c.blue), alpha: Double(c.opacity))
    }

    @Test func everyColourFollowsLightAndDark() {
        #expect(UsualColor.swatches.count >= 12)
        for swatch in UsualColor.swatches {
            #expect(resolved(swatch.color, .light) == swatch.colors.light, "\(swatch.name) in light")
            #expect(resolved(swatch.color, .dark) == swatch.colors.dark, "\(swatch.name) in dark")
        }
    }

    @Test func namedColoursAreTheSwatches() {
        #expect(resolved(UsualColor.background, .light) == UsualRGB(0xF6F7F8))
        #expect(resolved(UsualColor.background, .dark) == UsualRGB(0x0A0B0D))
        #expect(resolved(UsualColor.focus, .dark) == resolved(UsualColor.ink, .dark))
    }

    @Test func everyHatFollowsLightAndDark() {
        #expect(UsualHat.all.count == 12)
        for hat in UsualHat.all {
            for scheme in [ColorScheme.light, .dark] {
                #expect(resolved(hat.fillColor, scheme) == hat.fill.value(for: scheme), "\(hat.name) fill")
                #expect(resolved(hat.onColor, scheme) == hat.on.value(for: scheme), "\(hat.name) on")
                #expect(resolved(hat.tintColor, scheme) == hat.tint.value(for: scheme), "\(hat.name) tint")
            }
        }
    }
}

@Suite struct HatTests {
    @Test func aKeyMatchesItsOwnHat() {
        for hat in UsualHat.all {
            #expect(UsualHat.matching(hex: hat.key) == hat)
            #expect(UsualHat.matching(hex: hat.key.uppercased()) == hat)
        }
    }

    @Test func storedColoursLandOnTheHatTheWebPicks() {
        // The generator's JavaScript matched these for the gallery; Swift must agree.
        for inbox in GalleryContent.sample.inboxes {
            #expect(UsualHat.matching(hex: inbox.stored).name == inbox.hat, "\(inbox.stored)")
        }
    }

    @Test func textThatIsNotAColourGetsSlate() {
        #expect(UsualHat.matching(hex: "blue") == .slate)
        #expect(UsualHat.matching(hex: "#12345") == .slate)
    }

    @Test func namedFindsEachHat() {
        for hat in UsualHat.all { #expect(UsualHat.named(hat.name) == hat) }
        #expect(UsualHat.named("chartreuse") == nil)
    }
}

@Suite struct TypeTests {
    @Test func sizesAreFixedOnTheMac() {
        #if os(macOS)
            for role in UsualTextRole.allCases {
                for size in [DynamicTypeSize.xSmall, .large, .accessibility5] {
                    #expect(role.style.size(for: size) == role.style.size)
                }
            }
        #endif
    }

    @Test func rolesAreSensible() {
        for role in UsualTextRole.allCases {
            let s = role.style
            #expect(s.size >= 12 && s.iphoneSize >= s.size, "\(role)")
            #expect(s.lineHeight >= 1 && s.lineHeight <= 1.6, "\(role)")
        }
        #expect(UsualTextRole.wordmark.style.textStyle == nil)
    }
}

@Suite struct MotionTests {
    @Test func reducedMotionStopsMovementButKeepsFades() {
        #expect(UsualEasing.standard.animation(.base, reduceMotion: false) != nil)
        #expect(UsualEasing.standard.animation(.fast, reduceMotion: true) == nil)
        #expect(UsualEasing.standard.animation(.base, reduceMotion: true) == nil)
        #expect(UsualEasing.standard.animation(.slow, reduceMotion: true) == nil)
        #expect(UsualEasing.standard.animation(.fade, reduceMotion: true) != nil)
        #expect(UsualDuration.fade.seconds(reduceMotion: true) == UsualDuration.fade.seconds)
    }
}

@MainActor @Suite struct GalleryTests {
    @Test func galleryRendersBothSchemes() throws {
        #if os(macOS)
            for scheme in [ColorScheme.light, .dark] {
                let renderer = ImageRenderer(content: GalleryView().frame(width: 1100).environment(\.colorScheme, scheme))
                let image = try #require(renderer.nsImage)
                #expect(image.size.width >= 1100 && image.size.height > 2000)
            }
        #endif
    }

    @Test func sampleCoversTheStatesThePiecesShow() {
        let sample = GalleryContent.sample
        #expect(sample.rows.contains { $0.unread } && sample.rows.contains { !$0.unread })
        #expect(sample.rows.contains { $0.stack != nil } && sample.rows.contains { $0.comeBack != nil })
        #expect(sample.rows.contains { $0.done } && sample.rows.filter(\.selected).count == 1)
        #expect(Set(sample.reasons.map(\.state)).isSuperset(of: ["applied", "proposed", "undone"]))
        #expect(sample.inboxes.contains { $0.attention != nil })
        #expect(Set(sample.typeSamples.keys) == Set(UsualTextRole.allCases))
    }
}
