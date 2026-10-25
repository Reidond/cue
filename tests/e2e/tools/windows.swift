// `windows PID` prints, as JSON, what the user sees of an app right now: whether it is the
// active app (and which app is), whether it has a Dock icon, and its windows on screen with
// their window levels — how end-to-end cases check that a test run stays out of the way.
import AppKit

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("usage: windows PID\n".utf8))
    exit(2)
}

let app = NSRunningApplication(processIdentifier: pid)
let front = NSWorkspace.shared.frontmostApplication
let policy = switch app?.activationPolicy {
case .regular: "regular"
case .accessory: "accessory"
case .prohibited: "prohibited"
default: "not running"
}
// Front to back, as the window server stacks them.
let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let windows: [[String: Any]] = onScreen.filter { $0[kCGWindowOwnerPID as String] as? pid_t == pid }.map { window in
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return [
        "level": window[kCGWindowLayer as String] as? Int ?? 0,
        "width": bounds["Width"] as? Int ?? 0,
        "height": bounds["Height"] as? Int ?? 0,
    ]
}
let report: [String: Any] = [
    "active": app?.isActive ?? false,
    "frontmost": front.map { ["pid": Int($0.processIdentifier), "name": $0.localizedName ?? ""] } ?? NSNull(),
    "policy": policy,
    "windows": windows,
    "levels": [
        "desktop": Int(CGWindowLevelForKey(.desktopWindow)),
        "desktopIcons": Int(CGWindowLevelForKey(.desktopIconWindow)),
        "normal": Int(CGWindowLevelForKey(.normalWindow)),
    ],
]
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: json, as: UTF8.self))
