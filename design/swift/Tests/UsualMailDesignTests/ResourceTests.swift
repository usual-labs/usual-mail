import CoreText
import SwiftUI
import Testing

@testable import UsualMailDesign

#if canImport(AppKit)
    import AppKit
#endif

@Suite struct FontTests {
    @Test func everyBundledFaceRegistersAndResolves() {
        UsualFonts.register()
        #expect(UsualFonts.failures.isEmpty, "\(UsualFonts.failures)")
        for face in UsualFonts.faces {
            #expect(UsualFonts.isAvailable(face), "\(face.postScriptName) did not resolve")
        }
    }

    @Test func registeringTwiceIsHarmless() {
        UsualFonts.register()
        UsualFonts.register()
        #expect(UsualFonts.failures.isEmpty)
    }

    @Test func everyFamilyButMonoHasAFace() {
        for family in UsualFontFamily.allCases where family != .mono {
            #expect(UsualFonts.face(family, weight: .regular) != nil, "\(family) has no face")
        }
        #expect(UsualFonts.face(.mono, weight: .regular) == nil)
    }

    @Test func serifAndWordmarkHaveOnlyRegular() {
        for role in UsualTextRole.allCases where [.serif, .wordmark].contains(role.style.family) {
            #expect(role.style.weight == .regular, "\(role) asks a one-weight family for \(role.style.weight)")
        }
        // Asking the serif for semibold still gets its only face, never a synthesised bold.
        #expect(UsualFonts.face(.serif, weight: .semibold)?.postScriptName == "GeistSerif-Regular")
    }

    @Test func sansWeightsAreTheirOwnFiles() {
        #expect(UsualFonts.face(.sans, weight: .regular)?.postScriptName == "Geist-Regular")
        #expect(UsualFonts.face(.sans, weight: .medium)?.postScriptName == "Geist-Medium")
        #expect(UsualFonts.face(.sans, weight: .semibold)?.postScriptName == "Geist-SemiBold")
    }
}

@Suite struct IconTests {
    #if canImport(AppKit)
        @Test(arguments: UsualIcon.allCases)
        func iconResolvesAsTemplate(icon: UsualIcon) throws {
            let image = try #require(Bundle.usualMailDesign.image(forResource: icon.rawValue), "\(icon.rawValue) is not in the asset catalog")
            #expect(image.isTemplate, "\(icon.rawValue) is not a template image")
            #expect(image.size == NSSize(width: 24, height: 24))
        }
    #endif

    @Test func namesAreKebabCaseOfTheCases() {
        for icon in UsualIcon.allCases {
            let camel = icon.rawValue.split(separator: "-").enumerated()
                .map { $0.offset == 0 ? String($0.element) : $0.element.prefix(1).uppercased() + $0.element.dropFirst() }
                .joined()
            #expect("\(icon)" == camel)
        }
    }
}
