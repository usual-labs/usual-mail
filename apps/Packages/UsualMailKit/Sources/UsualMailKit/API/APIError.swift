import Foundation

/// Why a request to the server failed.
public enum APIError: Error, Hashable, Sendable {
    /// The server answered with an error body (`{ "error": { "code", "message" } }`), or with an error
    /// status and no readable body, in which case the code comes from the status. A `rate_limited` answer says in
    /// `retryAfter` how many whole seconds to wait, from its `Retry-After` header.
    case server(code: ErrorCode, message: String, status: Int, retryAfter: Int? = nil)
    /// The server couldn't be reached: offline, refused, timed out. The words say why; `cause` is the system's
    /// reason when it gave one, for a screen that words a case its own way (pairing).
    case unreachable(String, cause: URLError.Code? = nil)
    /// The server answered with something this app can't read.
    case unexpectedResponse(status: Int, detail: String)
    /// A route that needs a token was called before the device was paired.
    case notPaired

    /// The contract's error code, when the server sent one.
    public var code: ErrorCode? {
        if case .server(let code, _, _, _) = self { code } else { nil }
    }

    /// Whole seconds to wait before trying again, when the server said.
    public var retryAfter: Int? {
        if case .server(_, _, _, let seconds) = self { seconds } else { nil }
    }

    /// True when the request may succeed later without anything changing on this device.
    public var isOffline: Bool {
        if case .unreachable = self { true } else { false }
    }

    /// Why a request didn't reach the server, in words, for the common cases; empty otherwise, so no system error
    /// code ever shows.
    public static func reason(for error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            "This device is offline."
        case .cannotConnectToHost: "Nothing answered at its address."
        case .cannotFindHost, .dnsLookupFailed: "Its address wasn't found."
        case .timedOut: "It didn't answer in time."
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
            .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
            .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            "A secure connection to it couldn't be made."
        default: ""
        }
    }

    /// A wait in words: "40 seconds", "1 minute", "7 minutes" (minutes rounded up).
    public static func wait(seconds: Int) -> String {
        if seconds < 60 { return seconds == 1 ? "1 second" : "\(max(seconds, 0)) seconds" }
        let minutes = (seconds + 59) / 60
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .server(let code, let message, _, let retryAfter):
            switch code {
            case .unauthorized: "This device isn't signed in to the server any more."
            case .needsPerson: "Only a person can do that. \(message)"
            case .rateLimited:
                if let retryAfter {
                    "The server has had too many tries. Wait \(Self.wait(seconds: retryAfter)), then try again."
                } else {
                    "The server has had too many tries. Wait a few minutes, then try again."
                }
            default: message.isEmpty ? "The server refused (\(code.rawValue))." : message
            }
        case .unreachable(let detail, _):
            detail.isEmpty ? "Can't reach your server." : "Can't reach your server. \(detail)"
        case .unexpectedResponse(let status, let detail): "The server sent something unexpected (\(status)). \(detail)"
        case .notPaired: "Pair this device with your server first."
        }
    }
}

/// The error body every failed route returns (`ApiErrorBody` in core).
struct APIErrorBody: Decodable {
    struct Detail: Decodable {
        var code: ErrorCode
        var message: String
    }

    var error: Detail
}
