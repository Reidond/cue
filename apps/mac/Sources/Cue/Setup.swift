import AVFoundation
import CoreGraphics
import Foundation

/// What Cue needs from the Mac, checked on demand for Home.
struct SetupCheck: Identifiable {
    enum Item: String { case microphone, screenAudio, calendar }

    let item: Item
    let ok: Bool
    var id: Item { item }

    var title: String {
        switch item {
        case .microphone: "Microphone access"
        case .screenAudio: "Call audio access"
        case .calendar: "Calendar access"
        }
    }

    var detail: String {
        switch (item, ok) {
        case (.microphone, true): "Hears your side of the conversation"
        case (.microphone, false): "Allow in System Settings › Privacy & Security › Microphone"
        case (.screenAudio, true): "Hears the other people on the call"
        case (.screenAudio, false): "Allow in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen Cue"
        case (.calendar, true): "Offers to record calls from your calendar when they start"
        case (.calendar, false): "Lets Cue offer to record calls from your calendar when they start"
        }
    }

    /// The permissions. Speech recognition, the notes and the answers are the Cue plan's, which needs nothing installed.
    @MainActor
    static func all(_ preferences: Preferences) -> [SetupCheck] {
        [
            SetupCheck(item: .microphone, ok: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized),
            SetupCheck(item: .screenAudio, ok: CGPreflightScreenCaptureAccess()),
            SetupCheck(item: .calendar, ok: MeetingCalendar.hasAccess),
        ]
    }

    var settingsURL: URL? {
        switch item {
        case .microphone: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        case .screenAudio: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        case .calendar: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        }
    }
}
