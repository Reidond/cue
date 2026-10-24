import Foundation

/// Where Cue keeps its files and settings. CUE_HOME moves all of them into one
/// folder (and settings into their own defaults domain), so end-to-end tests
/// never touch the user's real library, preferences or notes.
private let sandbox = ProcessInfo.processInfo.environment["CUE_HOME"].map { URL(fileURLWithPath: $0) }

let appSupport: URL = {
    let base = sandbox?.appendingPathComponent("Application Support")
        ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let url = base.appendingPathComponent("Cue")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}()

/// The user's Documents folder; `CUE_HOME/Documents` under test.
let documentsFolder: URL = sandbox?.appendingPathComponent("Documents")
    ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

/// Cue's settings; the `com.andriishafar.cue.e2e` domain under test.
let appDefaults: UserDefaults = sandbox == nil ? .standard : UserDefaults(suiteName: "com.andriishafar.cue.e2e")!
