import Foundation
import Security

/// Who answers questions, judges what is a question and writes summaries.
enum ClaudeProvider: String, CaseIterable, Identifiable {
    /// The `claude` CLI, signed in with the user's Claude subscription.
    case claudeCode
    /// The Anthropic API, paid per use with the user's API key.
    case anthropicAPI

    var id: String { rawValue }
    var title: String { self == .claudeCode ? "Claude Code" : "Anthropic API" }
    var detail: String {
        self == .claudeCode ? "Your Claude subscription, through Claude Code signed in on this Mac"
            : "Pay as you go with an API key from the Claude Console"
    }
}

/// Who turns the call's speech into text, live and after a recording.
enum SpeechProvider: String, CaseIterable, Identifiable {
    /// whisper.cpp with the large-v3-turbo model, on this Mac.
    case whisper
    /// Deepgram's Nova-3, in the cloud.
    case deepgram

    var id: String { rawValue }
    var title: String { self == .whisper ? "Whisper on this Mac" : "Deepgram" }
    var detail: String {
        self == .whisper ? "Private: the audio never leaves this Mac. Needs a fast Mac"
            : "Nova-3 in the cloud: fast on any Mac. The call's audio goes to Deepgram"
    }
}

/// The API keys of the cloud providers, in the login keychain.
///
/// Under CUE_HOME they live in `CUE_HOME/Keychain.json` instead, so end-to-end runs never read or
/// change the user's own keys (nor wait on a keychain prompt nobody answers).
enum APIKey: String, CaseIterable, Identifiable {
    case anthropic, deepgram

    var id: String { rawValue }
    var title: String { self == .anthropic ? "Anthropic API key" : "Deepgram API key" }
    /// Where to make one.
    var console: URL {
        URL(string: self == .anthropic ? "https://platform.claude.com/settings/keys" : "https://console.deepgram.com")!
    }

    private static let service = "com.andriishafar.cue"
    private static let sandboxFile = ProcessInfo.processInfo.environment["CUE_HOME"]
        .map { URL(fileURLWithPath: $0).appendingPathComponent("Keychain.json") }

    /// The saved key, if there is one.
    var value: String? {
        if let file = Self.sandboxFile { return Self.sandboxKeys(file)[rawValue] }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]) { $1 } as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ key: String) throws {
        if let file = Self.sandboxFile {
            var keys = Self.sandboxKeys(file)
            keys[rawValue] = key
            try JSONSerialization.data(withJSONObject: keys, options: .sortedKeys).write(to: file, options: .atomic)
            return
        }
        let data = Data(key.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging([
                kSecValueData as String: data, kSecAttrLabel as String: "Cue — \(title)",
            ]) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Self.error(status) }
    }

    func remove() {
        if let file = Self.sandboxFile {
            var keys = Self.sandboxKeys(file)
            keys[rawValue] = nil
            try? JSONSerialization.data(withJSONObject: keys, options: .sortedKeys).write(to: file, options: .atomic)
            return
        }
        SecItemDelete(query as CFDictionary)
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: rawValue]
    }

    private static func sandboxKeys(_ file: URL) -> [String: String] {
        (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
    }

    private static func error(_ status: OSStatus) -> ServiceError {
        ServiceError("Couldn't save the key in the keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)")")
    }
}
