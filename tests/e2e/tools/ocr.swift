// `ocr IMAGE` prints the text macOS Vision reads in an image, one block per
// line, top to bottom — how end-to-end cases check rendered windows.
//
// Where Vision's accurate recognizer can't run (the Cue macOS VM: it fails with nilError on every device, and the fast one reads neither
// Cyrillic nor small text) it exits with 3, and the harness reads the image with Tesseract instead (harness/tesseract.ts), from the
// images `ocr --prepare IMAGE LIGHT DARK` writes: IMAGE over white, and over black with its colours inverted, both dark text on white, and
// twice as large: at their own size Tesseract read "1 file" as "1file" and "$0.00 of" as "50.00 ої", and at 1.5 times "Bee talk" as "Beetalk".
import AppKit
import CoreML
import Vision

let arguments = Array(CommandLine.arguments.dropFirst())
let preparing = arguments.first == "--prepare"
guard preparing ? arguments.count == 4 : arguments.count == 1 else {
    FileHandle.standardError.write(Data("usage: ocr IMAGE | ocr --prepare IMAGE LIGHT DARK\n".utf8))
    exit(2)
}
guard let source = NSImage(contentsOf: URL(fileURLWithPath: arguments[preparing ? 1 : 0]))?
    .cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("ocr: can't read the image\n".utf8))
    exit(1)
}

/// Offscreen snapshots are transparent around the text, which can be light (dark
/// mode) or dark: read the image over both a white and a black background.
func flattened(on color: CGColor, inverted: Bool = false) -> CGImage? {
    let gray = inverted || preparing
    let scale = preparing ? 2.0 : 1
    let rect = CGRect(x: 0, y: 0, width: (Double(source.width) * scale).rounded(), height: (Double(source.height) * scale).rounded())
    let context = CGContext(data: nil, width: Int(rect.width), height: Int(rect.height), bitsPerComponent: 8, bytesPerRow: 0,
                            space: gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: gray ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue)
    context?.interpolationQuality = .high
    context?.setFillColor(color)
    context?.fill(rect)
    context?.draw(source, in: rect)
    if inverted {
        context?.setBlendMode(.difference)
        context?.setFillColor(CGColor(gray: 1, alpha: 1))
        context?.fill(rect)
    }
    return context?.makeImage()
}

if preparing {
    for (image, path) in [(flattened(on: CGColor(gray: 1, alpha: 1)), arguments[2]),
                          (flattened(on: CGColor(gray: 0, alpha: 1), inverted: true), arguments[3])] {
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
              (try? png.write(to: URL(fileURLWithPath: path))) != nil
        else {
            FileHandle.standardError.write(Data("ocr: can't write \(path)\n".utf8))
            exit(1)
        }
    }
    exit(0)
}

/// Text and position of each block, or nil when the recognizer can't run. Read the candidates right
/// away: an observation's text can come back empty once another request has run.
func read(_ image: CGImage) -> [(text: String, box: CGRect)]? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    request.recognitionLanguages = ["en-US", "uk-UA"].filter(supported.contains)
    // On the Neural Engine, Vision reuses models compiled into ~/Library/Caches/<process name>;
    // with a stale copy there it dropped most of a page. The CPU reads the same every time.
    for (stage, devices) in (try? request.supportedComputeStageDevices) ?? [:] {
        if let cpu = devices.first(where: { if case .cpu = $0 { true } else { false } }) { request.setComputeDevice(cpu, for: stage) }
    }
    guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil else { return nil }
    return (request.results ?? []).compactMap { block in block.topCandidates(1).first.map { ($0.string, block.boundingBox) } }
}

func read(over color: CGColor) -> [(text: String, box: CGRect)]? {
    guard let image = flattened(on: color) else { return [] }
    return read(image)
}

guard let light = read(over: CGColor(gray: 1, alpha: 1)), let dark = read(over: CGColor(gray: 0, alpha: 1)) else {
    FileHandle.standardError.write(Data("ocr: Vision's accurate text recognizer can't run here\n".utf8))
    exit(3)
}
// Keep whichever background read more text, then add lines only the other one found.
var blocks = light.count >= dark.count ? light : dark
let found = Set(blocks.map(\.text))
blocks += (light.count >= dark.count ? dark : light).filter { !found.contains($0.text) }
blocks.sort {
    // Vision's origin is bottom-left; read top to bottom, then left to right.
    abs($0.box.midY - $1.box.midY) > 0.01 ? $0.box.midY > $1.box.midY : $0.box.minX < $1.box.minX
}
for block in blocks { print(block.text) }
