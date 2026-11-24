import Foundation

/// Where a person's Usual Mail server lives, for example `https://mail.example.com` or
/// `http://192.168.1.20:8787`. A path prefix, for a server behind a reverse proxy, is kept.
public struct ServerAddress: Hashable, Sendable, Codable {
    /// Scheme, host, optional port and optional path prefix, with no trailing slash.
    public let baseURL: URL

    public enum ParseError: Error, Equatable, Sendable {
        case empty
        case invalid
        /// Plain `http` to a host on the public internet would send the token unencrypted.
        case insecureHTTP(host: String)
    }

    /// Accepts what a person would type: with or without a scheme or a trailing slash. Without a scheme,
    /// local, private and Tailscale addresses get `http` and everything else `https`.
    public init(parsing input: String) throws(ParseError) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw .empty }
        let hasScheme = trimmed.contains("://")
        guard var components = URLComponents(string: hasScheme ? trimmed : "http://" + trimmed),
            let host = components.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), !host.isEmpty,
            components.user == nil, components.password == nil,
            components.query == nil, components.fragment == nil
        else { throw .invalid }

        let isPrivate = Self.isPrivate(host: host)
        if !hasScheme { components.scheme = isPrivate ? "http" : "https" }
        switch components.scheme?.lowercased() {
        case "https": break
        case "http" where isPrivate: break
        case "http": throw .insecureHTTP(host: host)
        default: throw .invalid
        }
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw .invalid }
        baseURL = url
    }

    /// A route on this server, for example `url("/v1/now")`.
    public func url(_ path: String) -> URL {
        URL(string: baseURL.absoluteString + path)!
    }

    /// Host and port, for showing to a person.
    public var displayName: String {
        guard let host = baseURL.host(percentEncoded: false) else { return baseURL.absoluteString }
        return baseURL.port.map { "\(host):\($0)" } ?? host
    }

    /// Whether the owner's password may be sent here (docs/contract.md, "The owner's password"; the security review of
    /// 2026-11-24, finding 9): over https, or plain http only to this machine or over Tailscale, which encrypts on its
    /// own. Plain http to any other private address would carry a reusable password readable to everyone on that
    /// network, so the app pairs there with a code, which works once, instead.
    public var carriesPasswords: Bool {
        if baseURL.scheme?.lowercased() == "https" { return true }
        guard let host = baseURL.host(percentEncoded: false) else { return false }
        return Self.isLoopbackOrTailscale(host: host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")))
    }

    /// This machine (`localhost`, 127.0.0.0/8, `::1`), or Tailscale: 100.64.0.0/10, `*.ts.net` and its IPv6 range,
    /// fd7a:115c:a1e0::/48.
    static func isLoopbackOrTailscale(host: String) -> Bool {
        let host = host.lowercased()
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".ts.net") { return true }
        if let octets = ipv4Octets(host) {
            return octets[0] == 127 || (octets[0] == 100 && (64...127).contains(octets[1]))
        }
        return host == "::1" || host == "0:0:0:0:0:0:0:1" || host.hasPrefix("fd7a:115c:a1e0:")
    }

    /// Loopback, private-network, link-local and Tailscale addresses, plus `.local` and single-label names.
    /// Traffic to these doesn't cross the open internet, so plain `http` is allowed.
    static func isPrivate(host: String) -> Bool {
        let host = host.lowercased()
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".ts.net") { return true }
        if let octets = ipv4Octets(host) {
            switch (octets[0], octets[1]) {
            case (127, _), (10, _), (192, 168), (169, 254), (172, 16...31), (100, 64...127): return true
            default: return false
            }
        }
        if host.contains(":") {
            return host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8")
                || host.hasPrefix("fe9") || host.hasPrefix("fea") || host.hasPrefix("feb")
        }
        return !host.contains(".")
    }

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let octets = parts.compactMap { Int($0) }.filter { (0...255).contains($0) }
        return octets.count == 4 ? octets : nil
    }
}

extension ServerAddress.ParseError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .empty: "Enter your server's address."
        case .invalid: "That isn't a web address. Try something like mail.example.com or 192.168.1.20:8787."
        case .insecureHTTP(let host):
            "\(host) is on the internet, so the app only connects to it over https."
        }
    }
}
