import Darwin
import Foundation

/// Launches Electron from inside `Blink.app` so macOS attributes privacy
/// permissions to Blink instead of to the user's terminal.
///
/// macOS blames the *responsible process* for a TCC request, not the process
/// that called the API. Spawning `electron .` straight from a shell makes the
/// terminal responsible, so Screen Recording has to be granted to Ghostty or
/// iTerm — and every child of that terminal inherits the grant.
///
/// LaunchServices assigns a freshly opened `.app` responsibility for itself,
/// and children inherit it. So `open -a Blink.app` → this launcher → Electron
/// → `screencapture` all resolve to one identity: Blink. No private
/// responsibility-disclaiming SPI is involved on this path.
///
/// The launcher must outlive the spawn. If it exited immediately, Electron
/// would be reparented and the app would read as terminated, so it waits and
/// forwards the child's exit code.
enum Launcher {
  /// Set for the child so the audio helper can tell it is running under an app
  /// that owns the capture grants. Diagnostics only — inheritance is automatic.
  static let responsibleMarker = "BLINK_RESPONSIBLE"

  static func run() -> Int32 {
    // LaunchServices historically appends a process serial number argument.
    let arguments = CommandLine.arguments.dropFirst().filter {
      !$0.hasPrefix("-psn_")
    }

    guard let packageRoot = arguments.first ?? derivePackageRoot() else {
      log("could not resolve the Blink package directory")
      return 1
    }
    guard
      let electron = arguments.dropFirst().first ?? findElectron(packageRoot: packageRoot)
    else {
      log("could not find the Electron binary under \(packageRoot)")
      return 1
    }
    guard FileManager.default.isExecutableFile(atPath: electron) else {
      log("electron binary is not executable: \(electron)")
      return 1
    }

    var environment = ProcessInfo.processInfo.environment
    environment[responsibleMarker] = "1"

    let process = Process()
    process.executableURL = URL(fileURLWithPath: electron)
    process.arguments = [packageRoot]
    process.environment = environment
    redirectOutput(of: process)

    do {
      try process.run()
    } catch {
      log("failed to launch \(electron): \(error.localizedDescription)")
      return 1
    }

    process.waitUntilExit()
    return process.terminationStatus
  }

  /// LaunchServices gives the app no terminal, so anything Electron prints would
  /// otherwise be lost — leaving a failed launch with no diagnostics at all.
  /// Truncated per launch so it cannot grow without bound.
  private static func redirectOutput(of process: Process) {
    let logFile = blinkHome().appendingPathComponent("blink.log")
    FileManager.default.createFile(atPath: logFile.path, contents: nil)
    guard let handle = try? FileHandle(forWritingTo: logFile) else { return }
    process.standardOutput = handle
    process.standardError = handle
  }

  private static func blinkHome() -> URL {
    let directory = URL(fileURLWithPath:
      ProcessInfo.processInfo.environment["BLINK_HOME"] ?? NSHomeDirectory() + "/.blink-ai")
    try? FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true)
    return directory
  }

  /// `<package>/vendor/Blink.app/Contents/MacOS/Blink` → `<package>`.
  private static func derivePackageRoot() -> String? {
    var size = UInt32(PATH_MAX)
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    var url = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.path
  }

  /// Package managers either nest `electron` under Blink or hoist it beside
  /// the scoped package, so check both rather than assuming a layout.
  private static func findElectron(packageRoot: String) -> String? {
    if let override = ProcessInfo.processInfo.environment["BLINK_ELECTRON_PATH"],
      !override.isEmpty
    {
      return override
    }

    let suffix = "electron/dist/Electron.app/Contents/MacOS/Electron"
    let root = URL(fileURLWithPath: packageRoot)
    let candidates = [
      root.appendingPathComponent("node_modules/\(suffix)"),
      root.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent(suffix),
      root.deletingLastPathComponent().appendingPathComponent(suffix),
    ]
    return candidates.first { FileManager.default.fileExists(atPath: $0.path) }?.path
  }

  /// `open` discards stdio, so failures would otherwise be invisible. Leave a
  /// breadcrumb `blink-ai doctor` can point at.
  private static func log(_ message: String) {
    FileHandle.standardError.write(Data("[blink-launcher] \(message)\n".utf8))

    let logFile = blinkHome().appendingPathComponent("launcher.log")
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = Data("\(stamp) \(message)\n".utf8)

    if let handle = try? FileHandle(forWritingTo: logFile) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: line)
    } else {
      try? line.write(to: logFile)
    }
  }
}

exit(Launcher.run())
