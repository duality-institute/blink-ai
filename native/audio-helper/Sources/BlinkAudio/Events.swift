import Foundation

/// Which captured stream a transcript segment came from.
///
/// `them` is system output audio — what the meeting app is playing, tapped
/// digitally before it reaches the speakers. `you` is the local microphone.
enum Speaker: String, Codable {
  case them
  case you
}

enum EventKind: String, Codable {
  /// Capture and transcription are live; the supervisor may start trusting output.
  case ready
  /// Progress that is useful but not fatal, such as a first-run model download.
  case status
  /// A transcript segment, volatile or final.
  case transcript
  /// A fatal condition; the process exits after emitting this.
  case error
}

/// One line of NDJSON on stdout.
///
/// Optional fields are omitted when nil so the supervisor can discriminate on
/// `kind` without guarding every property.
struct Event: Codable {
  let kind: EventKind
  var speaker: Speaker?
  var text: String?
  /// False for volatile results, which are revised as more audio arrives.
  /// True once the segment is settled and will never change again.
  var isFinal: Bool?
  var startMs: Int?
  var endMs: Int?
  var message: String?

  static func ready() -> Event {
    Event(kind: .ready)
  }

  static func status(_ message: String) -> Event {
    Event(kind: .status, message: message)
  }

  static func error(_ message: String) -> Event {
    Event(kind: .error, message: message)
  }

  static func transcript(
    speaker: Speaker,
    text: String,
    isFinal: Bool,
    startMs: Int,
    endMs: Int
  ) -> Event {
    Event(
      kind: .transcript,
      speaker: speaker,
      text: text,
      isFinal: isFinal,
      startMs: startMs,
      endMs: endMs
    )
  }
}

/// Serializes NDJSON writes from the two capture streams, which arrive on
/// separate dispatch queues.
///
/// stdout is a pipe under the supervisor, so it is block-buffered; every line is
/// flushed explicitly or the parent would see transcripts arrive in delayed bursts.
final class EventEmitter: @unchecked Sendable {
  static let shared = EventEmitter()

  private let lock = NSLock()
  private let encoder = JSONEncoder()

  private init() {
    encoder.outputFormatting = []
  }

  func emit(_ event: Event) {
    guard let data = try? encoder.encode(event),
      let line = String(data: data, encoding: .utf8)
    else { return }

    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
  }

  /// Diagnostics go to stderr so they can never be mistaken for NDJSON events.
  func log(_ message: String) {
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardError.write(Data("[blink-audio] \(message)\n".utf8))
  }
}
