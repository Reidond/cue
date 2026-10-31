// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "Cue",
    platforms: [.macOS("26.0")],
    dependencies: [
        // Offline speaker diarization for the call side of recordings. No traits: the default one
        // links a text-normalization engine for speech synthesis, which Cue doesn't use.
        .package(url: "https://github.com/FluidInference/FluidAudio", from: "0.17.7", traits: []),
    ],
    targets: [
        .executableTarget(
            name: "Cue",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/Cue",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
