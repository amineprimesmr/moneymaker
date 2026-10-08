// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MoneyMaker",
    platforms: [.iOS(.v16), .macOS(.v13), .watchOS(.v9), .tvOS(.v16), .visionOS(.v1)],
    products: [.library(name: "MoneyMaker", targets: ["MoneyMaker"])],
    targets: [
        .target(name: "MoneyMaker", path: "Sources/MoneyMaker"),
        .testTarget(name: "MoneyMakerTests", dependencies: ["MoneyMaker"], path: "Tests/MoneyMakerTests"),
    ]
)
