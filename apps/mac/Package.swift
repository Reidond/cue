// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "Cue",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "Cue",
            path: "Sources/Cue",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
