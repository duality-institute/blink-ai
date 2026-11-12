// swift-tools-version: 6.0
import PackageDescription

// BlinkAudio is a headless command-line helper, not an app. It captures meeting
// audio and transcribes it on device, emitting NDJSON on stdout for the Electron
// main process to consume. Swift language mode 5 keeps the AVFoundation and
// ScreenCaptureKit callback bridging straightforward; those APIs deliver buffers
// on their own dispatch queues rather than through Swift concurrency.
let package = Package(
  name: "BlinkAudio",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(
      name: "BlinkAudio",
      path: "Sources/BlinkAudio",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
