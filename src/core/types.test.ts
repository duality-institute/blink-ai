import { describe, it, expect } from "bun:test";
import { CAPTURE_ACCELERATORS } from "./types";
import type {
  AnswerComplete,
  AnswerDelta,
  AnswerError,
  AnswerRecord,
  BlinkConfig,
} from "./types";

describe("types", () => {
  it("should define BlinkConfig interface", () => {
    const config: BlinkConfig = {
      backend: "claude",
      hideFromCapture: true,
      showTranscript: true,
      monitorPrompt: "",
      meetingPrompt: "",
    };
    expect(config.backend).toBe("claude");
  });

  it("uses distinct region and screen capture accelerators", () => {
    expect(CAPTURE_ACCELERATORS.region).not.toBe(CAPTURE_ACCELERATORS.screen);
  });

  it("should define AnswerRecord interface", () => {
    const record: AnswerRecord = {
      timestamp: new Date().toISOString(),
      source: "monitor",
      screenshotPaths: ["/path/to/screenshot.png"],
      answer: "Test answer",
      durationMs: 1000,
    };
    expect(record.answer).toBe("Test answer");
  });

  it("should define streaming event types", () => {
    const delta: AnswerDelta = { type: "delta", text: "partial" };
    const complete: AnswerComplete = {
      type: "complete",
      text: "full",
      reconciled: false,
    };
    const error: AnswerError = { type: "error", message: "failed" };

    expect(delta.type).toBe("delta");
    expect(complete.type).toBe("complete");
    expect(error.type).toBe("error");
  });
});
