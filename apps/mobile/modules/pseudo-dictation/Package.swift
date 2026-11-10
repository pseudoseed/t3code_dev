// swift-tools-version: 6.0
import PackageDescription

// The app builds this module through CocoaPods. This manifest exists so the core can be compiled
// and tested on a Mac without an iOS build. Keep the FluidAudio revision equal to the one in
// `apps/mobile/plugins/withDictationPods.cjs`.
let package = Package(
  name: "PseudoDictation",
  platforms: [.macOS(.v14), .iOS(.v18)],
  dependencies: [
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git",
      revision: "c8b41f98eae668794dd0083bbe028fe7e6585051")
  ],
  targets: [
    .target(
      name: "PseudoDictationCore",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "ios/Core",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "PseudoDictationCoreTests",
      dependencies: ["PseudoDictationCore"],
      path: "Tests/PseudoDictationCoreTests",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
