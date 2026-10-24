// `ocr IMAGE` prints the text macOS Vision reads in an image, one block per
// line, top to bottom — how end-to-end cases check rendered windows.
import AppKit
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

func read(_ image: CGImage) -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    request.recognitionLanguages = ["en-US", "uk-UA"].filter(supported.contains)
    try? VNImageRequestHandler(cgImage: image).perform([request])
    return request.results ?? []
}

let light = flattened(on: CGColor(gray: 1, alpha: 1)).map(read) ?? []
let dark = flattened(on: CGColor(gray: 0, alpha: 1)).map(read) ?? []
// Keep whichever background read more text, then add lines only the other one found.
var blocks = light.count >= dark.count ? light : dark
let found = Set(blocks.compactMap { $0.topCandidates(1).first?.string })
blocks += (light.count >= dark.count ? dark : light).filter { $0.topCandidates(1).first.map { !found.contains($0.string) } ?? false }
blocks.sort {
    // Vision's origin is bottom-left; read top to bottom, then left to right.
    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 ? $0.boundingBox.midY > $1.boundingBox.midY
        : $0.boundingBox.minX < $1.boundingBox.minX
}
for block in blocks {
    if let text = block.topCandidates(1).first?.string { print(text) }
}
