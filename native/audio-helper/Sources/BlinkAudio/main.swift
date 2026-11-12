import AVFoundation
import CoreGraphics
import Foundation

/// Blink's audio helper.
///
/// Captures the remote meeting participant (system audio) and the local microphone,
/// transcribes both on device, and writes one NDJSON event per line to stdout. It
/// draws no UI and writes no audio to disk; buffers go straight from the capture
/// callback into the transcriber and are then released.
///
/// The Electron main process spawns and supervises this exactly the way it already
/// supervises `opencode serve`.
///
/// This binary has no bundle and no identity of its own. It lives inside
/// `Blink.app/Contents/Helpers/`, so TCC walks up to Blink.app and reads that
/// bundle's usage strings — which is what keeps microphone and system audio under
/// one "Blink" entry in System Settings instead of two.

// Answered before anything else writes to stdout, which must carry only the answer.
switch CommandLine.arguments.dropFirst().first {
case "--screen-access":
  print(CGPreflightScreenCaptureAccess())
  exit(0)
case "--request-screen-access":
  print(CGRequestScreenCaptureAccess())
  exit(0)
default:
  break
}

// Launched outside Blink.app there is no app to inherit from, and TCC denies
// capture *silently* — no prompt, and the stream simply delivers nothing. Say so,
// because otherwise this is invisible.
if ProcessInfo.processInfo.environment["BLINK_RESPONSIBLE"] == nil {
  EventEmitter.shared.log(
    "not launched by Blink.app; macOS will deny audio capture without prompting"
  )
}

/// Owns the capture and transcription lifecycle so the signal handlers have a single
/// object to shut down.
final class Runner: @unchecked Sendable {
  private var capture: AudioCapture?
  private var systemTranscriber: StreamTranscriber?
  private var microphoneTranscriber: StreamTranscriber?
  private let shutdownLock = NSLock()
  private var isShuttingDown = false

  func run() async {
    do {
      let preferred = Locale.current
      let locale = await StreamTranscriber.resolveLocale(preferred: preferred)

      let system = StreamTranscriber(speaker: .them, locale: locale)
      let microphone = StreamTranscriber(speaker: .you, locale: locale)
      systemTranscriber = system
      microphoneTranscriber = microphone

      // Started sequentially so a first-run model download happens once rather than
      // racing two identical requests for the same locale.
      try await system.start()
      try await microphone.start()

      let capture = AudioCapture(
        systemSink: { system.ingest($0) },
        microphoneSink: { microphone.ingest($0) },
        onStop: { message in
          EventEmitter.shared.emit(.error("capture stopped: \(message)"))
          exit(1)
        }
      )
      self.capture = capture
      try await capture.start()

      EventEmitter.shared.emit(.ready())
    } catch {
      EventEmitter.shared.emit(.error(error.localizedDescription))
      exit(1)
    }
  }

  /// Returns false when another signal already started the teardown.
  private func beginShutdown() -> Bool {
    shutdownLock.lock()
    defer { shutdownLock.unlock() }
    if isShuttingDown { return false }
    isShuttingDown = true
    return true
  }

  /// Stops capture first, then flushes the analyzers so trailing speech still lands.
  func shutdown() async {
    guard beginShutdown() else { return }

    await capture?.stop()
    await systemTranscriber?.finish()
    await microphoneTranscriber?.finish()
  }
}

let runner = Runner()

// DispatchSource rather than signal(), so the handler can await an async shutdown
// instead of being restricted to async-signal-safe calls.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)

for source in [terminateSource, interruptSource] {
  source.setEventHandler {
    Task {
      await runner.shutdown()
      exit(0)
    }
  }
  source.resume()
}

Task {
  await runner.run()
}

dispatchMain()
