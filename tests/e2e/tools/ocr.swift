// `ocr IMAGE` prints the text macOS Vision reads in an image, one block per
// line, top to bottom — how end-to-end cases check rendered windows.
import AppKit
import CoreML
import Vision

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: ocr IMAGE\n".utf8))
    exit(2)
}
guard let source = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))?
    .cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("ocr: can't read the image\n".utf8))
    exit(1)
}

/// Offscreen snapshots are transparent around the text, which can be light (dark
/// mode) or dark: read the image over both a white and a black background.
func flattened(on color: CGColor) -> CGImage? {
    let context = CGContext(data: nil, width: source.width, height: source.height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    let rect = CGRect(x: 0, y: 0, width: source.width, height: source.height)
    context?.setFillColor(color)
    context?.fill(rect)
    context?.draw(source, in: rect)
    return context?.makeImage()
}

/// Text and position of each block. Read the candidates right away: an observation's
/// text can come back empty once another request has run.
func read(_ image: CGImage) -> [(text: String, box: CGRect)] {
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
    try? VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { block in block.topCandidates(1).first.map { ($0.string, block.boundingBox) } }
}

let light = flattened(on: CGColor(gray: 1, alpha: 1)).map(read) ?? []
let dark = flattened(on: CGColor(gray: 0, alpha: 1)).map(read) ?? []
// Keep whichever background read more text, then add lines only the other one found.
var blocks = light.count >= dark.count ? light : dark
let found = Set(blocks.map(\.text))
blocks += (light.count >= dark.count ? dark : light).filter { !found.contains($0.text) }
blocks.sort {
    // Vision's origin is bottom-left; read top to bottom, then left to right.
    abs($0.box.midY - $1.box.midY) > 0.01 ? $0.box.midY > $1.box.midY : $0.box.minX < $1.box.minX
}
for block in blocks { print(block.text) }
