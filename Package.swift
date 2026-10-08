// swift-tools-version:5.9
// Root manifest so the SDK can be added with: https://github.com/amineprimesmr/moneymaker
import PackageDescription

let package = Package(
    name: "MoneyMaker",
    platforms: [.iOS(.v16), .macOS(.v13), .watchOS(.v9), .tvOS(.v16), .visionOS(.v1)],
    products: [.library(name: "MoneyMaker", targets: ["MoneyMaker"])],
    targets: [
        .target(name: "MoneyMaker", path: "sdk/ios/Sources/MoneyMaker"),
        .testTarget(name: "MoneyMakerTests", dependencies: ["MoneyMaker"], path: "sdk/ios/Tests/MoneyMakerTests"),
    ]
)
