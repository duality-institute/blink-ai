import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

enum CaptureError: LocalizedError {
  case noDisplay

  var errorDescription: String? {
    switch self {
    case .noDisplay:
      return "no display available to attach the audio capture stream to"
    }
  }
}

/// Captures the remote participant and the local microphone as two separate
/// streams.
///
/// ScreenCaptureKit is used rather than Core Audio process taps because taps break
/// in exactly the situations meetings create: the output device switching to a
/// Bluetooth headset mid-call, the default output clock going idle, or a browser
/// re-routing audio in-page. It uses macOS's dedicated Screen & System Audio
/// Recording grant for the Blink Audio helper.
///
/// System audio is tapped digitally before it reaches the speakers, so it stays
/// clean with headphones on and at zero volume — it is not the microphone
/// re-hearing the call.
final class AudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
  private let systemSink: (CMSampleBuffer) -> Void
  private let microphoneSink: (CMSampleBuffer) -> Void
  private let onStop: (String) -> Void

  // One serial queue per stream keeps each StreamTranscriber confined to a single
  // thread, which is what lets its converter state stay lock-free.
  private let systemQueue = DispatchQueue(label: "ai.blink.audio.system")
  private let microphoneQueue = DispatchQueue(label: "ai.blink.audio.microphone")
  private let screenQueue = DispatchQueue(label: "ai.blink.audio.screen")

  private var stream: SCStream?

  init(
    systemSink: @escaping (CMSampleBuffer) -> Void,
    microphoneSink: @escaping (CMSampleBuffer) -> Void,
    onStop: @escaping (String) -> Void
  ) {
    self.systemSink = systemSink
    self.microphoneSink = microphoneSink
    self.onStop = onStop
  }

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: false
    )
    guard let display = content.displays.first else { throw CaptureError.noDisplay }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.captureMicrophone = true
    // Without this, Blink's own playback would be transcribed back as the remote
    // party.
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2

    // Audio-only capture is not expressible here: the stream is fundamentally a
    // screen stream that happens to carry audio. Keep the video path at the minimum
    // the API accepts and discard every frame.
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 5
    configuration.showsCursor = false

    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: systemQueue)
    try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: microphoneQueue)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)

    try await stream.startCapture()
    self.stream = stream
  }

  func stop() async {
    guard let stream else { return }
    self.stream = nil
    try? await stream.stopCapture()
  }

  // MARK: - SCStreamOutput

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard sampleBuffer.isValid else { return }

    switch type {
    case .audio:
      systemSink(sampleBuffer)
    case .microphone:
      microphoneSink(sampleBuffer)
    default:
      break  // screen frames are required by the API but carry nothing we want
    }
  }

  // MARK: - SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    onStop(error.localizedDescription)
  }
}
