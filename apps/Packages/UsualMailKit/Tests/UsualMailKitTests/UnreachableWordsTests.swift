import Foundation
import Testing

@testable import UsualMailKit

/// Why the server can't be reached, in the app's own words, never the system's error codes (first launch, 2026-11-17:
/// the status strip read "The operation couldn't be completed. (NSURLErrorDomain error -1009.)").
struct UnreachableWordsTests {
    @Test(arguments: [
        (URLError.Code.notConnectedToInternet, "Can't reach your server. This device is offline."),
        (.networkConnectionLost, "Can't reach your server. This device is offline."),
        (.cannotConnectToHost, "Can't reach your server. Nothing answered at its address."),
        (.cannotFindHost, "Can't reach your server. Its address wasn't found."),
        (.dnsLookupFailed, "Can't reach your server. Its address wasn't found."),
        (.timedOut, "Can't reach your server. It didn't answer in time."),
        (.secureConnectionFailed, "Can't reach your server. A secure connection to it couldn't be made."),
        (.serverCertificateUntrusted, "Can't reach your server. A secure connection to it couldn't be made."),
    ])
    func commonFailuresAreWords(code: URLError.Code, words: String) {
        let error = APIClient.transportError(URLError(code))
        #expect(error as? APIError == .unreachable(APIError.reason(for: URLError(code)), cause: code))
        #expect((error as? APIError)?.localizedDescription == words)
    }

    @Test func noSystemCodeShows() {
        let error = APIClient.transportError(URLError(.badServerResponse))
        let words = (error as? APIError)?.localizedDescription ?? ""
        #expect(!words.contains("NSURLErrorDomain"))
        #expect(words == "Can't reach your server.")
    }
}
