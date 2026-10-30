// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RTLSdrAgent",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "RTLSdrAgent",
            path: "Sources/RTLSdrAgent"
        )
    ]
)
