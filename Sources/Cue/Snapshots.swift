import AppKit
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Testing aid behind CUE_SNAPSHOT: PNGs of Cue's windows, every 2 s, for cases to read and agents to look at.
///
/// With Screen Recording access each window's real pixels come from the window server — glass,
/// materials and selection as the user sees them — in the system appearance (or CUE_APPEARANCE's).
/// Without it (a CI runner), or for a window that isn't on screen (the overlay before Start Cue),
/// the window is drawn by the app instead: layout and text only, in the light appearance. The session
/// log says which (`📸 Snapshots: …`); CUE_SNAPSHOT_METHOD=desktop|window|display|offscreen picks one.
@MainActor
final class Snapshots {
    enum Method: String {
        /// The screen under the window with only the desktop picture behind it: the glass over real
        /// pixels, yet nothing but Cue's own — no other window covers it or shows through.
        case desktop
        /// The window by itself: glass that looks through the window (the overlay's) shows over nothing.
        case window
        /// The screen under the window, minus the windows in front of it: exactly what's behind it now,
        /// the user's other windows included.
        case display
        /// Drawn by the app (`cacheDisplay`, `ImageRenderer`): no glass, materials or selection.
        case offscreen
    }

    /// A window to snapshot, the PNG it goes to and how the app draws it when it can't be captured.
    struct Target {
        let name: String
        let window: NSWindow
        let path: String
        let draw: () -> CGImage?
    }

    /// This run's method, and why it is offscreen when it is.
    static let plan: (method: Method, reason: String?) = {
        let asked = ProcessInfo.processInfo.environment["CUE_SNAPSHOT_METHOD"].flatMap(Method.init(rawValue:)) ?? .desktop
        if asked == .offscreen { return (.offscreen, "CUE_SNAPSHOT_METHOD=offscreen") }
        // Only check: asking would put up a permission prompt that nobody answers in a test run.
        guard CGPreflightScreenCaptureAccess() else { return (.offscreen, "no Screen Recording access") }
        return (asked, nil)
    }()

    /// Whether this run's snapshots are drawn by the app, which can't draw some views (selectable text).
    static var drawn: Bool { ProcessInfo.processInfo.environment["CUE_SNAPSHOT"] != nil && plan.method == .offscreen }

    private let log: SessionLog
    private var busy = false
    /// How each window's last snapshot was taken: the log notes when that isn't as planned, and changes.
    private var taken: [String: String] = [:]

    init(log: SessionLog) {
        self.log = log
        // Glass and scroll-edge effects draw as white offscreen: in the light appearance text stays readable on them.
        if Self.plan.method == .offscreen, NSApp.appearance == nil { NSApp.appearance = NSAppearance(named: .aqua) }
        let dark = (NSApp.appearance ?? NSApp.effectiveAppearance).bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        log.write("📸 Snapshots: \(Self.describe(Self.plan.method)), in the \(dark ? "dark" : "light") appearance"
            + (Self.plan.reason.map { " — \($0)" } ?? ""))
    }

    /// Writes each target's PNG; skipped while the previous round is still capturing.
    func take(_ targets: [Target]) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            var content: SCShareableContent?, failure: String?
            if Self.plan.method != .offscreen {
                do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
                catch { failure = error.localizedDescription }
            }
            for target in targets {
                let (image, how) = await snapshot(target, content: content, failure: failure)
                if how != (taken[target.name] ?? Self.describe(Self.plan.method)) { log.write("📸 \(target.name): \(how)") }
                taken[target.name] = how
                if let image { Self.write(image, to: target.path) }
            }
        }
    }

    private static func describe(_ method: Method) -> String {
        switch method {
        case .desktop: "window capture (over the desktop picture)"
        case .window: "window capture (the window alone)"
        case .display: "window capture (over the screen)"
        case .offscreen: "offscreen"
        }
    }

    /// The target's image and how it was taken: captured as planned, else how and why not.
    private func snapshot(_ target: Target, content: SCShareableContent?, failure: String?) async -> (CGImage?, String) {
        guard Self.plan.method != .offscreen else { return (target.draw(), Self.describe(.offscreen)) }
        func drawn(_ reason: String) -> (CGImage?, String) { (target.draw(), "offscreen — \(reason)") }
        guard let content else { return drawn(failure ?? "no windows to capture") }
        guard target.window.isVisible, let window = content.windows.first(where: { $0.windowID == CGWindowID(target.window.windowNumber) })
        else { return drawn("not on screen") }
        // Over what's behind it, the window must be all on one display; else it's captured alone.
        var method = Self.plan.method, reason = ""
        let display = content.displays.first { $0.frame.contains(window.frame) }
        if method != .window, display == nil { (method, reason) = (.window, " — partly off screen") }
        do {
            return (try await Self.capture(window, method: method, display: display, in: content), Self.describe(method) + reason)
        } catch {
            return drawn(error.localizedDescription)
        }
    }

    /// The window's pixels at its display's backing scale.
    private static func capture(_ window: SCWindow, method: Method, display: SCDisplay?, in content: SCShareableContent) async throws -> CGImage {
        let filter: SCContentFilter, size: CGSize, config = SCStreamConfiguration()
        config.showsCursor = false
        config.captureResolution = .best
        if method != .window, let display {
            let others: [SCWindow]
            if method == .desktop {
                // Every other window, the desktop's icons, the Dock and the menu bar left out: the desktop picture stays.
                let icons = Int(CGWindowLevelForKey(.desktopIconWindow))
                others = content.windows.filter { $0.windowID != window.windowID && $0.windowLayer >= icons }
            } else {
                let above = (CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], window.windowID) as? [[String: Any]] ?? [])
                    .compactMap { $0[kCGWindowNumber as String] as? CGWindowID }
                others = content.windows.filter { above.contains($0.windowID) }
            }
            filter = SCContentFilter(display: display, excludingWindows: others)
            filter.includeMenuBar = false
            config.sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            size = window.frame.size
        } else {
            filter = SCContentFilter(desktopIndependentWindow: window)
            config.ignoreShadowsSingleWindow = true
            size = filter.contentRect.size
        }
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int((size.width * scale).rounded())
        config.height = Int((size.height * scale).rounded())
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    private static func write(_ image: CGImage, to path: String) {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, image, nil)
        if CGImageDestinationFinalize(destination) { try? (data as Data).write(to: URL(fileURLWithPath: path), options: .atomic) }
    }

    /// A window with its title bar drawn by the app, on an opaque background (the window server draws the real one).
    static func draw(_ window: NSWindow) -> CGImage? {
        guard let root = window.contentView?.superview,
              let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(root.bounds.width * 2), pixelsHigh: Int(root.bounds.height * 2),
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        canvas.size = root.bounds.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: canvas)
        func draw(_ view: NSView, background: Bool) {
            var rect = view.convert(view.bounds, to: root)
            if root.isFlipped { rect.origin.y = root.bounds.height - rect.maxY }
            if background {
                view.effectiveAppearance.performAsCurrentDrawingAppearance {
                    NSColor.windowBackgroundColor.setFill()
                    rect.fill()
                }
            }
            guard !rect.isEmpty, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        }
        draw(root, background: true)
        // Glass (the sidebar, toolbar items) caches empty: draw what's inside it on top, and
        // the sidebar's rows one by one, which the list doesn't draw into the cache either.
        func glass(in view: NSView) {
            for subview in view.subviews where !subview.isHidden {
                if let effect = subview as? NSGlassEffectView, let content = effect.contentView {
                    draw(content, background: true)
                }
                if let table = subview as? NSTableView {
                    for row in 0..<table.numberOfRows {
                        guard let rowView = table.rowView(atRow: row, makeIfNecessary: false) else { continue }
                        // While Cue is the active app the selected row is a material that caches as a
                        // solid bar, hiding its text: draw the row unselected.
                        let selected = rowView.isSelected
                        rowView.isSelected = false
                        rowView.layoutSubtreeIfNeeded()
                        draw(rowView, background: false)
                        rowView.isSelected = selected
                    }
                }
                glass(in: subview)
            }
        }
        glass(in: root)
        NSGraphicsContext.restoreGraphicsState()
        return canvas.cgImage
    }
}
