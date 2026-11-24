import Foundation

/// Talks to a Usual Mail server over its REST routes (`core/src/api.ts`). One method per route lives in
/// APIClient+Routes.swift; this file builds requests and reads responses.
public struct APIClient: Sendable {
    public let server: ServerAddress
    /// The device's token from pairing. Routes other than `/healthz`, `/v1/info` and `/v1/pair` need it.
    public let token: String?
    let transport: any HTTPTransport

    public init(server: ServerAddress, token: String? = nil, transport: any HTTPTransport = URLSessionTransport()) {
        self.server = server
        self.token = token
        self.transport = transport
    }

    public func withToken(_ token: String) -> APIClient {
        APIClient(server: server, token: token, transport: transport)
    }

    enum Method: String {
        case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
    }

    /// Builds a request. `path` starts with `/` and has its parameters already escaped by `segment(_:)`.
    func request(
        _ method: Method, _ path: String, query: [(String, String)] = [], body: (any Encodable)? = nil,
        authorized: Bool = true, accept: String = "application/json"
    ) throws(APIError) -> URLRequest {
        var components = URLComponents(url: server.url(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.percentEncodedQuery = query.map { "\(Self.escapeQuery($0))=\(Self.escapeQuery($1))" }
                .joined(separator: "&")
        }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method.rawValue
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if authorized {
            guard let token else { throw .notPaired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            do {
                request.httpBody = try MailJSON.encoder().encode(body)
            } catch {
                throw .unexpectedResponse(status: 0, detail: "Couldn't write the request: \(error)")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Sends a request and decodes its JSON response.
    func send<Response: Decodable>(_ request: URLRequest, as type: Response.Type = Response.self) async throws
        -> Response
    {
        let (data, response) = try await perform(request)
        do {
            return try MailJSON.decoder().decode(Response.self, from: data)
        } catch {
            throw APIError.unexpectedResponse(status: response.statusCode, detail: "Couldn't read the reply: \(error)")
        }
    }

    /// Sends a request whose answer is `null` or a value, such as the latest brief.
    func sendOptional<Response: Decodable>(_ request: URLRequest, as type: Response.Type = Response.self)
        async throws -> Response?
    {
        let (data, response) = try await perform(request)
        if data.isEmpty || response.statusCode == 204 { return nil }
        do {
            return try MailJSON.decoder().decode(Response?.self, from: data)
        } catch {
            throw APIError.unexpectedResponse(status: response.statusCode, detail: "Couldn't read the reply: \(error)")
        }
    }

    /// Sends a request whose success has no body (`204`).
    func sendWithoutReply(_ request: URLRequest) async throws {
        _ = try await perform(request)
    }

    /// Sends a request; throws `APIError` for a failed status or an unreachable server.
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch let error as APIError {
            throw error
        } catch {
            throw Self.transportError(error)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw Self.error(
                status: response.statusCode, body: data,
                retryAfter: response.value(forHTTPHeaderField: "Retry-After"))
        }
        return (data, response)
    }

    static func transportError(_ error: any Error) -> any Error {
        if error is CancellationError || Task.isCancelled { return CancellationError() }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled { return CancellationError() }
            return APIError.unreachable(APIError.reason(for: urlError), cause: urlError.code)
        }
        return APIError.unreachable(error.localizedDescription)
    }

    /// Maps an error response to `APIError.server`, using the body's code when it has one. `retryAfter` is the
    /// `Retry-After` header, which the contract gives in whole seconds on `rate_limited`.
    static func error(status: Int, body: Data, retryAfter: String? = nil) -> APIError {
        let seconds = retryAfter.flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 >= 0 ? $0 : nil }
        if let decoded = try? JSONDecoder().decode(APIErrorBody.self, from: body) {
            return .server(
                code: decoded.error.code, message: decoded.error.message, status: status, retryAfter: seconds)
        }
        return .server(
            code: ErrorCode(status: status), message: HTTPURLResponse.localizedString(forStatusCode: status),
            status: status, retryAfter: seconds)
    }

    /// Escapes one path parameter. Ids are opaque, so even `/` is escaped.
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// Escapes a query name or value. `+` is escaped too: servers read a bare `+` as a space.
    static func escapeQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// RFC 3986's unreserved characters.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func listQuery(_ query: ListQuery) -> [(String, String)] {
        var items: [(String, String)] = []
        if let inboxId = query.inboxId { items.append(("inboxId", inboxId)) }
        if let cursor = query.cursor { items.append(("cursor", cursor)) }
        if let limit = query.limit { items.append(("limit", String(limit))) }
        return items
    }
}
