import CoreText
import Foundation

/// One bundled font file.
public struct UsualFontFace: Hashable, Sendable {
    public let family: UsualFontFamily
    public let weight: Int
    public let postScriptName: String
    /// The file's name in Resources/Fonts.
    public let file: String
}

/// The bundled fonts: Geist Serif, Geist Sans and Prociono. `register()` makes them available to this process.
/// `.usualFont(_:)` registers them on first use, so call `register()` only before using the names directly.
public enum UsualFonts {
    /// Registers every bundled font with Core Text for this process. Safe to call more than once.
    public static func register() { _ = registration }

    /// The faces that failed to register, by PostScript name, with Core Text's error. Empty when all is well.
    public static var failures: [String: String] { registration }

    /// Whether Core Text now resolves the face's PostScript name to that face rather than a fallback.
    public static func isAvailable(_ face: UsualFontFace) -> Bool {
        register()
        let font = CTFontCreateWithName(face.postScriptName as CFString, 12, nil)
        return CTFontCopyPostScriptName(font) as String == face.postScriptName
    }

    /// The face for a family and weight: the exact weight if bundled, else the nearest. Nil for mono, which is the
    /// system's.
    public static func face(_ family: UsualFontFamily, weight: UsualFontWeight) -> UsualFontFace? {
        faces.filter { $0.family == family }.min { abs($0.weight - weight.rawValue) < abs($1.weight - weight.rawValue) }
    }

    /// Runs once, the first time anything asks. A static let is initialised lazily and exactly once.
    private static let registration: [String: String] = {
        var failures: [String: String] = [:]
        for face in faces {
            guard let url = Bundle.module.url(forResource: face.file, withExtension: nil, subdirectory: "Fonts")
                ?? Bundle.module.url(forResource: face.file, withExtension: nil)
            else {
                failures[face.postScriptName] = "\(face.file) is not in the bundle"
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error), let error = error?.takeRetainedValue() {
                // Already registered (by an earlier call or by the app itself) is fine.
                if CFErrorGetCode(error) != CTFontManagerError.alreadyRegistered.rawValue {
                    failures[face.postScriptName] = CFErrorCopyDescription(error) as String
                }
            }
        }
        return failures
    }()
}
