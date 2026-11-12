// swift-tools-version: 6.0
import PackageDescription

// BlinkLauncher is the executable inside `vendor/Blink.app`. It exists purely
// to give Blink a TCC identity of its own: LaunchServices makes an opened .app
// its own responsible process, and the Electron it spawns inherits that.
//
// It is a separate package from BlinkAudio because SwiftPM sets the deployment
// target per package, not per target. Meeting listening needs macOS 26 for
// SpeechAnalyzer, but screenshots work far earlier, so the launcher must not
// inherit that floor or it would refuse to start on supported systems.
let package = Package(
  name: "BlinkLauncher",
  platforms: [.macOS("12.0")],
  targets: [
    .executableTarget(
      name: "BlinkLauncher",
      path: "Sources/BlinkLauncher",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
