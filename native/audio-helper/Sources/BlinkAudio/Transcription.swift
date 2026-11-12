import AVFoundation
import Foundation
import Speech

/// Runs one on-device `SpeechAnalyzer` session for a single labeled audio stream.
///
/// One instance per speaker, so the system-audio and microphone streams stay
/// independently attributed instead of being merged into ambiguous text.
///
/// Audio buffers arrive from ScreenCaptureKit on a dedicated serial queue owned by
/// `AudioCapture`; each instance is fed from exactly one such queue. Only
/// `analyzerFormat` crosses a thread boundary, so it is the one piece of state
/// guarded by a lock.
final class StreamTranscriber: @unchecked Sendable {
  private let speaker: Speaker
  private let transcriber: SpeechTranscriber
  private let analyzer: SpeechAnalyzer
  private let inputStream: AsyncStream<AnalyzerInput>
  private let inputContinuation: AsyncStream<AnalyzerInput>.Continuation

  private let formatLock = NSLock()
  private var analyzerFormat: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var resultsTask: Task<Void, Never>?

  init(speaker: Speaker, locale: Locale) {
    self.speaker = speaker
    // Progressive gives live volatile results that revise as speech continues;
    // time-indexed attaches the audio time ranges the rolling window needs to
    // decide what counts as "the last 45 seconds".
    self.transcriber = SpeechTranscriber(
      locale: locale,
      preset: .timeIndexedProgressiveTranscription
    )
    self.analyzer = SpeechAnalyzer(modules: [transcriber])

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.inputStream = stream
    self.inputContinuation = continuation
  }

  /// Resolves a locale this device can actually transcribe.
  ///
  /// `supportedLocales` is the full catalog; a locale still needs its model
  /// installed before use. Falls back to en-US rather than failing outright.
  static func resolveLocale(preferred: Locale) async -> Locale {
    if let match = await SpeechTranscriber.supportedLocale(equivalentTo: preferred) {
      return match
    }
    let english = Locale(identifier: "en-US")
    if let match = await SpeechTranscriber.supportedLocale(equivalentTo: english) {
      return match
    }
    return english
  }

  func start() async throws {
    try await installAssetsIfNeeded()

    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    setAnalyzerFormat(format)

    resultsTask = Task { [weak self] in
      await self?.consumeResults()
    }

    try await analyzer.start(inputSequence: inputStream)
  }

  /// Model assets ship from Apple on first use, not bundled with Blink. This is the
  /// only step that touches the network; transcription itself is fully on device.
  private func installAssetsIfNeeded() async throws {
    let status = await AssetInventory.status(forModules: [transcriber])
    guard status != .installed else { return }

    if let request = try await AssetInventory.assetInstallationRequest(
      supporting: [transcriber]
    ) {
      EventEmitter.shared.emit(.status("downloading speech model"))
      try await request.downloadAndInstall()
      EventEmitter.shared.emit(.status("speech model ready"))
    }
  }

  private func consumeResults() async {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters).trimmingCharacters(
          in: .whitespacesAndNewlines
        )
        guard !text.isEmpty else { continue }

        EventEmitter.shared.emit(
          .transcript(
            speaker: speaker,
            text: text,
            isFinal: result.isFinal,
            startMs: milliseconds(from: result.range.start),
            endMs: milliseconds(from: result.range.end)
          )
        )
      }
    } catch is CancellationError {
      return
    } catch {
      EventEmitter.shared.emit(
        .error("transcription failed for \(speaker.rawValue): \(error.localizedDescription)")
      )
    }
  }

  private func milliseconds(from time: CMTime) -> Int {
    guard time.isValid, !time.isIndefinite else { return 0 }
    let seconds = time.seconds
    guard seconds.isFinite, seconds >= 0 else { return 0 }
    return Int(seconds * 1000)
  }

  // Lock/unlock stay inside synchronous helpers. Calling them directly from an async
  // context is rejected under Swift 6 concurrency checking, since a suspension while
  // holding a lock can deadlock.
  private func setAnalyzerFormat(_ format: AVAudioFormat?) {
    formatLock.lock()
    defer { formatLock.unlock() }
    analyzerFormat = format
  }

  private func currentAnalyzerFormat() -> AVAudioFormat? {
    formatLock.lock()
    defer { formatLock.unlock() }
    return analyzerFormat
  }

  /// Called from the capture queue for every incoming sample buffer.
  func ingest(_ sampleBuffer: CMSampleBuffer) {
    guard let target = currentAnalyzerFormat() else { return }

    guard let sourceFormat = Self.format(of: sampleBuffer) else { return }
    let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0,
      let sourceBuffer = AVAudioPCMBuffer(
        pcmFormat: sourceFormat,
        frameCapacity: frameCount
      )
    else { return }
    sourceBuffer.frameLength = frameCount

    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer,
      at: 0,
      frameCount: Int32(frameCount),
      into: sourceBuffer.mutableAudioBufferList
    )
    guard status == noErr else { return }

    if let converted = convert(sourceBuffer, to: target) {
      inputContinuation.yield(AnalyzerInput(buffer: converted))
    }
  }

  private static func format(of sampleBuffer: CMSampleBuffer) -> AVAudioFormat? {
    guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)
    else { return nil }
    return AVAudioFormat(streamDescription: asbd)
  }

  /// ScreenCaptureKit delivers 48kHz stereo; the analyzer asks for its own preferred
  /// format. Feeding it unconverted audio is the classic silent failure here — it
  /// accepts the buffers and simply never produces text.
  private func convert(
    _ input: AVAudioPCMBuffer,
    to target: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    if input.format == target { return input }

    if converter == nil || converter?.inputFormat != input.format {
      converter = AVAudioConverter(from: input.format, to: target)
      converter?.primeMethod = .none
    }
    guard let converter else { return nil }

    let ratio = target.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
      return nil
    }

    var conversionError: NSError?
    var consumed = false
    converter.convert(to: output, error: &conversionError) { _, statusPointer in
      if consumed {
        statusPointer.pointee = .noDataNow
        return nil
      }
      consumed = true
      statusPointer.pointee = .haveData
      return input
    }

    guard conversionError == nil, output.frameLength > 0 else { return nil }
    return output
  }

  /// Flushes any audio still inside the analyzer so the final words of a session are
  /// not lost, then tears the session down.
  func finish() async {
    inputContinuation.finish()
    let task = resultsTask
    do {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      await task?.value
    } catch {
      task?.cancel()
      await task?.value
    }
    resultsTask = nil
  }
}
