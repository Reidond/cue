import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import Security

/// What `GET /v1/me` says (packages/contract: `Me`): who is signed in, the plan, its limits and the usage this month.
struct CueMe: Decodable, Equatable {
    struct Account: Decodable, Equatable {
        let id: String
        let email: String
        let name: String
        let role: String
    }
    struct Plan: Decodable, Equatable {
        let id: String
        let name: String
    }
    struct Limits: Decodable, Equatable {
        let monthlyUsd: Double?
    }
    struct Usage: Decodable, Equatable {
        let month: String
        let usd: Double
        let audioSeconds: Double
    }
    let account: Account
    let plan: Plan
    let limits: Limits
    let usage: Usage
}

/// Why a call to the Cue API didn't work.
enum CueAPIError: LocalizedError {
    /// The identity provider vouched for the person, but they aren't on the list.
    case notInvited(String?)
    /// They closed the sign-in window.
    case cancelled
    /// The session is over (refresh token revoked or expired, user disabled): sign in again.
    case ended(String)
    /// The API said no.
    case server(String)
    /// The API couldn't be reached.
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notInvited(let email):
            "\(email ?? "That account") hasn't been invited to Cue yet. Cue is invite-only: ask whoever runs it to invite that email address, or sign in with another account."
        case .cancelled: "Sign-in was cancelled."
        case .ended(let why), .server(let why): why
        case .network(let why): "Couldn't reach Cue: \(why)"
        }
    }
}

/// A secret kept in the login keychain, like the API keys; under CUE_HOME in `CUE_HOME/Keychain.json` instead, so end-to-end
/// runs never read or change the user's own, nor wait on a keychain prompt nobody answers.
enum SecretStore {
    private static let service = "com.andriishafar.cue"
    private static let sandboxFile = ProcessInfo.processInfo.environment["CUE_HOME"]
        .map { URL(fileURLWithPath: $0).appendingPathComponent("Keychain.json") }

    static func get(_ account: String) -> String? {
        if let file = sandboxFile { return sandboxSecrets(file)[account] }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query(account).merging([
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]) { $1 } as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for account: String, label: String) throws {
        if let file = sandboxFile {
            var secrets = sandboxSecrets(file)
            secrets[account] = value
            try JSONSerialization.data(withJSONObject: secrets, options: .sortedKeys).write(to: file, options: .atomic)
            return
        }
        let data = Data(value.utf8)
        var status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(account).merging([
                kSecValueData as String: data, kSecAttrLabel as String: label,
            ]) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw ServiceError("Couldn't save it in the keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)")")
        }
    }

    static func remove(_ account: String) {
        if let file = sandboxFile {
            var secrets = sandboxSecrets(file)
            secrets[account] = nil
            try? JSONSerialization.data(withJSONObject: secrets, options: .sortedKeys).write(to: file, options: .atomic)
            return
        }
        SecItemDelete(query(account) as CFDictionary)
    }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private static func sandboxSecrets(_ file: URL) -> [String: String] {
        (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
    }
}

/// The URL scheme the browser sheet hands the sign-in back to the app by (the OAuth redirect is `com.andriishafar.cue:/oauth/callback`).
private let callbackScheme = "com.andriishafar.cue"

/// Stops the headless sign-in at the redirect back to the app (a custom scheme URLSession can't follow) and keeps it.
private final class RedirectCatcher: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    var callback: URL?

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        if let url = request.url, url.scheme == callbackScheme {
            callback = url
            return nil
        }
        return request
    }
}

private extension Data {
    /// Base64 without padding, with `-` and `_`: what PKCE and OAuth state use.
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// The Cue API's client, and who is signed in: an OAuth 2.1 public client (Authorization Code with PKCE, through the system's
/// browser sheet), the refresh token in the keychain, the access token (a JWT, 15 minutes) kept in memory and refreshed silently.
/// Cue works only while someone is signed in (`isSignedIn`): everything else in the app waits for it.
@MainActor
final class CueAPI: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    enum Phase { case restoring, signedOut, signingIn, signedIn }

    /// CUE_API_URL points the app at another backend (end-to-end cases run their own).
    static let baseURL = URL(string: ProcessInfo.processInfo.environment["CUE_API_URL"] ?? "https://api.cue.app")!
    private static let redirectURI = "\(callbackScheme):/oauth/callback"
    private static let clientID = "cue-mac"
    /// The API's identifier in OAuth (RFC 8707 `resource`; the access token's `aud`). Never fetched.
    private static let audience = "https://api.cue.test"
    private static let account = "cueRefreshToken"

    @Published private(set) var phase = Phase.signedOut
    /// The signed-in account, its plan and usage; nil while signed out.
    @Published private(set) var me: CueMe?
    /// What went wrong the last time, for the sign-in screen: "not invited" is said plainly.
    @Published private(set) var problem: String?

    var isSignedIn: Bool { phase == .signedIn }

    private let log: SessionLog
    private var accessToken: String?
    private var refreshAt = Date.distantPast
    private var refreshing: Task<String, Error>?
    private var webSession: ASWebAuthenticationSession?
    private var timer: Timer?
    /// CUE_WEB_AUTH=headless follows the authorize URL with URLSession up to the redirect back, instead of showing the browser sheet.
    private let headless = ProcessInfo.processInfo.environment["CUE_WEB_AUTH"] == "headless"
    /// How often the account is read again (seconds): usage, and whether the account is still allowed. CUE_ME_TICK shortens it in tests.
    private let tick = ProcessInfo.processInfo.environment["CUE_ME_TICK"].flatMap(TimeInterval.init) ?? 300

    init(log: SessionLog) {
        self.log = log
        super.init()
    }

    /// At launch: a saved refresh token signs in again without anyone noticing; without one, the sign-in screen.
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.isSignedIn { await self.refreshMe() } else if self.phase == .signedOut, SecretStore.get(Self.account) != nil { await self.restore() }
            }
        }
        if SecretStore.get(Self.account) != nil {
            phase = .restoring
            Task { await restore() }
        }
    }

    // MARK: Signing in and out

    /// Sign in: the browser sheet for Google or GitHub, then the code for tokens.
    func signIn() async {
        guard phase != .signingIn, phase != .signedIn else { return }
        phase = .signingIn
        problem = nil
        do {
            let verifier = Self.random(32), state = Self.random(12)
            let returned = try await authorize(url: authorizeURL(verifier: verifier, state: state))
            let code = try Self.code(in: returned, state: state)
            try await store(tokens: tokenRequest([
                "grant_type": "authorization_code", "code": code, "redirect_uri": Self.redirectURI, "code_verifier": verifier,
            ]))
            try await loadMe()
            becameSignedIn()
        } catch CueAPIError.cancelled {
            phase = .signedOut
        } catch CueAPIError.notInvited(let email) {
            phase = .signedOut
            problem = CueAPIError.notInvited(email).errorDescription
            log.write("⚠︎ Not invited: \(email ?? "unknown email")")
        } catch {
            SecretStore.remove(Self.account)
            phase = .signedOut
            problem = error.localizedDescription
            log.write("⚠︎ Couldn't sign in to Cue: \(error.localizedDescription)")
        }
    }

    /// Sign Out: the backend revokes the refresh token, then it's gone from the keychain.
    func signOut() async {
        if let token = SecretStore.get(Self.account) {
            var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/auth/oauth2/revoke"))
            request.httpMethod = "POST"
            request.timeoutInterval = 10
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.form(["client_id": Self.clientID, "token": token, "token_type_hint": "refresh_token"])
            _ = try? await URLSession.shared.data(for: request)
        }
        reset()
        log.write("🔑 Signed out of Cue")
    }

    /// The session is over for a reason that isn't the person's doing: say why, and go to the sign-in screen.
    private func endSession(_ why: String) {
        guard phase != .signedOut || SecretStore.get(Self.account) != nil else { return }
        log.write("⚠︎ Your Cue session ended: \(why)")
        reset()
        problem = why
        log.write("🔑 Signed out of Cue")
    }

    private func reset() {
        SecretStore.remove(Self.account)
        accessToken = nil
        refreshAt = .distantPast
        me = nil
        problem = nil
        phase = .signedOut
    }

    private func becameSignedIn() {
        phase = .signedIn
        log.write("🔑 Signed in to Cue as \(me?.account.email ?? "unknown")")
    }

    /// Signing in again from the refresh token the last run left in the keychain.
    private func restore() async {
        phase = .restoring
        do {
            _ = try await validAccessToken()
            try await loadMe()
            becameSignedIn()
        } catch CueAPIError.ended(let why) {
            endSession(why)
        } catch {
            // Offline, say: the token stays, and the next check tries again.
            phase = .signedOut
            problem = error.localizedDescription
        }
    }

    // MARK: Account

    /// Reads `/v1/me` again (usage, plan); a session that has ended since is signed out.
    func refreshMe() async {
        do {
            try await loadMe()
        } catch CueAPIError.ended(let why) {
            endSession(why)
        } catch {
            // Offline: keep what was shown.
        }
    }

    private func loadMe() async throws {
        let data = try await get("v1/me")
        do {
            me = try JSONDecoder().decode(CueMe.self, from: data)
        } catch {
            throw CueAPIError.server("Cue answered something unexpected: \(error.localizedDescription)")
        }
    }

    // MARK: Requests

    /// `GET path` with the access token, refreshed when it's about to run out or was refused.
    func get(_ path: String) async throws -> Data {
        var token = try await validAccessToken()
        for attempt in 0..<2 {
            var request = URLRequest(url: Self.baseURL.appendingPathComponent(path))
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
            request.setValue("mac/\(version)", forHTTPHeaderField: "Cue-Version")
            let (data, status) = try await send(request)
            if status == 401 && attempt == 0 {
                token = try await refreshAccessToken()
                continue
            }
            if status == 401 { throw CueAPIError.ended(Self.message(in: data) ?? "Your session has ended. Sign in to Cue again.") }
            guard (200..<300).contains(status) else { throw CueAPIError.server(Self.message(in: data) ?? "Cue answered \(status).") }
            return data
        }
        throw CueAPIError.server("Cue didn't accept the sign-in.")
    }

    private func validAccessToken() async throws -> String {
        if let accessToken, Date() < refreshAt { return accessToken }
        return try await refreshAccessToken()
    }

    /// One refresh at a time: refresh tokens rotate, and using one twice ends the session.
    private func refreshAccessToken() async throws -> String {
        if let refreshing { return try await refreshing.value }
        guard let token = SecretStore.get(Self.account) else { throw CueAPIError.ended("You're signed out.") }
        let task = Task { () throws -> String in
            try await self.store(tokens: self.tokenRequest(["grant_type": "refresh_token", "refresh_token": token]))
            if self.isSignedIn { self.log.write("🔑 Cue access refreshed") }
            return self.accessToken ?? ""
        }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private struct Tokens: Decodable {
        let accessToken: String
        let refreshToken: String?
        let expiresIn: Double?
    }

    private func store(tokens: Tokens) throws {
        accessToken = tokens.accessToken
        // Refresh a little before it runs out (a quarter of its life, at most 30 s).
        let life = tokens.expiresIn ?? 900
        refreshAt = Date().addingTimeInterval(life - min(30, life / 4))
        if let refresh = tokens.refreshToken { try SecretStore.set(refresh, for: Self.account, label: "Cue — Account") }
    }

    /// The token endpoint. `invalid_grant` means the grant is over; anything else the server didn't like is its message.
    private func tokenRequest(_ parameters: [String: String]) async throws -> Tokens {
        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/auth/oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.form(parameters.merging(["client_id": Self.clientID, "resource": Self.audience]) { $1 })
        let (data, status) = try await send(request)
        guard status == 200 else {
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if body?["error"] as? String == "invalid_grant" { throw CueAPIError.ended("Your session has ended. Sign in to Cue again.") }
            throw CueAPIError.server(body?["error_description"] as? String ?? "Cue didn't accept the sign-in (\(status)).")
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(Tokens.self, from: data)
        } catch {
            throw CueAPIError.server("Cue answered something unexpected: \(error.localizedDescription)")
        }
    }

    private func send(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw CueAPIError.network(error.localizedDescription)
        }
    }

    private static func message(in data: Data) -> String? {
        ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
    }

    private static func form(_ parameters: [String: String]) -> Data {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return Data(parameters.sorted { $0.key < $1.key }.map {
            "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&").utf8)
    }

    // MARK: The browser part

    private static func random(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URL
    }

    private func authorizeURL(verifier: String, state: String) -> URL {
        var components = URLComponents(url: Self.baseURL.appendingPathComponent("api/auth/oauth2/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: Self.clientID),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "scope", value: "openid profile email offline_access"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: Data(SHA256.hash(data: Data(verifier.utf8))).base64URL),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "resource", value: Self.audience),
        ]
        return components.url!
    }

    /// The URL the sign-in ended at: the redirect back to the app (with a code, or with `not_invited`), or the invite-only page.
    private func authorize(url: URL) async throws -> URL {
        if headless { return try await authorizeHeadless(url) }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme)) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: CueAPIError.cancelled)
                } else {
                    continuation.resume(throwing: CueAPIError.server(error?.localizedDescription ?? "Sign-in failed."))
                }
            }
            session.presentationContextProvider = self
            webSession = session
            if !session.start() { continuation.resume(throwing: CueAPIError.server("Couldn't open the sign-in window.")) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) ?? ASPresentationAnchor()
        }
    }

    /// CUE_WEB_AUTH=headless: what the browser sheet does, by hand: follow the redirects (with cookies), press Google's button on the sign-in
    /// page, and stop at the redirect back to the app.
    private func authorizeHeadless(_ start: URL) async throws -> URL {
        let catcher = RedirectCatcher()
        let session = URLSession(configuration: .ephemeral)
        var request = URLRequest(url: start)
        for _ in 0..<8 {
            // What a browser says, so the authorization endpoint answers with a redirect instead of JSON.
            request.setValue("navigate", forHTTPHeaderField: "Sec-Fetch-Mode")
            request.setValue("text/html", forHTTPHeaderField: "Accept")
            let result: (Data, URLResponse)
            do {
                result = try await session.data(for: request, delegate: catcher)
            } catch {
                throw CueAPIError.network(error.localizedDescription)
            }
            let (data, response) = result
            if let callback = catcher.callback { return callback }
            guard let http = response as? HTTPURLResponse, let landed = http.url else { break }
            if landed.path == "/invite-only" || landed.path == "/sign-in-failed" { return landed }
            // Without a browser's `Sec-Fetch-Mode` the authorization endpoint answers with JSON instead of a redirect.
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], json["redirect"] as? Bool == true,
               let link = json["url"] as? String, let next = URL(string: link, relativeTo: Self.baseURL)?.absoluteURL {
                if next.scheme == callbackScheme { return next }
                request = URLRequest(url: next)
                continue
            }
            guard landed.path == "/login", http.statusCode == 200,
                  let page = String(data: data, encoding: .utf8),
                  let match = page.range(of: "href=\"(/login/google\\?[^\"]*)\"", options: .regularExpression)
            else { break }
            let link = String(page[match]).dropFirst(6).dropLast()
                .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&#38;", with: "&")
            guard let next = URL(string: link, relativeTo: Self.baseURL)?.absoluteURL else { break }
            request = URLRequest(url: next)
        }
        throw CueAPIError.server("The sign-in didn't end at the app.")
    }

    /// The code in the redirect back to the app; or the reason there is none.
    private static func code(in url: URL, state: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if url.path == "/invite-only" || value("error_description") == "not_invited" { throw CueAPIError.notInvited(value("email")) }
        let disabled = value("error_description") == "account_disabled"
            || (value("error") ?? "").range(of: "ban|disabled", options: [.regularExpression, .caseInsensitive]) != nil
        if disabled { throw CueAPIError.server("This account has been disabled. Ask whoever runs Cue about it.") }
        if url.path == "/sign-in-failed" { throw CueAPIError.server("Something went wrong signing you in. Try again.") }
        if let error = value("error") { throw CueAPIError.server(value("error_description") ?? error) }
        guard value("state") == state, let code = value("code") else { throw CueAPIError.server("The sign-in came back without a code.") }
        return code
    }
}
