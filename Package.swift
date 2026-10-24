// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SeminarOverlay",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "SeminarOverlay",
            path: "Sources/SeminarOverlay",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
