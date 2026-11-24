import CoreGraphics
import Foundation
import ImageIO

@testable import UsualMailKit

/// The stand-in server's sender pictures (docs/contract-avatars.md), as the server's demo serves the sample's: a drawn
/// PNG for each picture a thread or message of the sample names (`thr_4`, `thr_8`, `thr_11` and their incoming
/// messages), `not_found` for any other id. A test may give an id its own reply.
extension SampleServer {
    func avatar(_ id: String) -> StubReply {
        if let reply = state.withLock({ $0.avatarReplies[id] }) { return reply }
        let named =
            data.threads.contains { $0.avatar?.id == id } || data.messages.contains { $0.avatar?.id == id }
        guard named else { return .error("not_found", "No such picture", status: 404) }
        return .picture(TestPicture.png(width: 48, height: 48), type: "image/png")
    }

    /// Answers `id` with `reply` from now on.
    func answerAvatar(_ id: String, with reply: StubReply) {
        state.withLock { $0.avatarReplies[id] = reply }
    }

    /// How many times the picture with this id was asked for.
    func avatarRequests(_ id: String) -> Int {
        requests.filter { $0.url?.path == "/v1/avatars/\(id)" }.count
    }
}

extension StubReply {
    /// A picture as the route serves it: its bytes, its type and the route's caching.
    static func picture(_ bytes: Data, type: String) -> StubReply {
        StubReply(
            status: 200, body: bytes,
            headers: ["Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable"])
    }
}

/// Small pictures drawn with Core Graphics, for tests.
enum TestPicture {
    /// A square of one colour, encoded as `type` ("public.png", "public.jpeg").
    static func encoded(width: Int, height: Int, as type: String) -> Data {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(srgbRed: 0.21, green: 0.36, blue: 0.29, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, type as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    static func png(width: Int, height: Int) -> Data {
        encoded(width: width, height: height, as: "public.png")
    }

    static func jpeg(width: Int, height: Int) -> Data {
        encoded(width: width, height: height, as: "public.jpeg")
    }
}
