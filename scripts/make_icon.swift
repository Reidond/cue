// Renders Resources/AppIcon.icns: a speech-bubble glyph on a blue squircle.
// Run: swift scripts/make_icon.swift
import AppKit

let canvas: CGFloat = 1024
let inset: CGFloat = 100  // macOS icon grid: 824 pt body inside a 1024 canvas
let image = NSImage(size: NSSize(width: canvas, height: canvas), flipped: false) { _ in
    let body = NSRect(x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2)
    let squircle = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
    NSGradient(colors: [NSColor(red: 0.30, green: 0.56, blue: 1.0, alpha: 1),
                        NSColor(red: 0.13, green: 0.31, blue: 0.92, alpha: 1)])!
        .draw(in: squircle, angle: -90)
    let config = NSImage.SymbolConfiguration(pointSize: 430, weight: .medium)
        .applying(.init(paletteColors: [NSColor(red: 0.20, green: 0.42, blue: 0.96, alpha: 1), .white]))
    if let symbol = NSImage(systemSymbolName: "text.bubble.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(config) {
        let size = symbol.size
        symbol.draw(in: NSRect(x: (canvas - size.width) / 2, y: (canvas - size.height) / 2 - 8,
                               width: size.width, height: size.height))
    }
    return true
}

let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = base * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        NSGraphicsContext.restoreGraphicsState()
        let name = "icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png"
        try! rep.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(name))
    }
}
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", "Resources/AppIcon.icns"]
try! task.run()
task.waitUntilExit()
print(task.terminationStatus == 0 ? "Wrote Resources/AppIcon.icns" : "iconutil failed")
