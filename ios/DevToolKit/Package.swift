// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DevToolKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "DevToolKit", targets: ["DevToolKit"]),
    ],
    targets: [
        .target(name: "DevToolKit"),
        .testTarget(
            name: "DevToolKitTests",
            dependencies: ["DevToolKit"]
        ),
    ]
)
