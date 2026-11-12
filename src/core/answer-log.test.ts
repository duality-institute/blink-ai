import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendAnswer, readRecent } from "./answer-log";
import type { AnswerRecord } from "./types";

function answer(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    timestamp: "2025-08-13T10:00:00Z",
    source: "monitor",
    screenshotPaths: ["/path/to/screenshot.png"],
    answer: "This is the answer",
    durationMs: 1_500,
    ...overrides,
  };
}

describe("answer-log", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-test-"));
    process.env["BLINK_HOME"] = tempDir;
  });

  afterEach(() => {
    delete process.env["BLINK_HOME"];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the log file on first append", () => {
    appendAnswer(answer());

    expect(fs.existsSync(path.join(tempDir, "answers.jsonl"))).toBe(true);
  });

  it("appends final Monitor and Meeting records as parseable Unicode lines", () => {
    appendAnswer(answer({ answer: "héllo ✓ 42" }));
    appendAnswer(
      answer({
        timestamp: "2025-08-13T10:01:00Z",
        source: "meeting",
        screenshotPaths: ["/private/one.png", "/private/two.png"],
        answer: "회의 답변",
        durationMs: 2_000,
      }),
    );

    const lines = fs
      .readFileSync(path.join(tempDir, "answers.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AnswerRecord);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.answer).toBe("héllo ✓ 42");
    expect(lines[1]).toMatchObject({
      source: "meeting",
      screenshotPaths: ["/private/one.png", "/private/two.png"],
      answer: "회의 답변",
    });
  });

  it("returns no records when the log is absent or the requested count is zero", () => {
    expect(readRecent(10)).toEqual([]);
    appendAnswer(answer());
    expect(readRecent(0)).toEqual([]);
  });

  it("returns the requested tail without failing when n exceeds the log", () => {
    for (let index = 0; index < 5; index += 1) {
      appendAnswer(
        answer({
          timestamp: `2025-08-13T10:0${index}:00Z`,
          answer: `Answer ${index}`,
          durationMs: 1_000 + index * 100,
        }),
      );
    }

    expect(readRecent(3).map((record) => record.answer)).toEqual([
      "Answer 2",
      "Answer 3",
      "Answer 4",
    ]);
    expect(readRecent(10)).toHaveLength(5);
  });

  it("stores only metadata and answer text, never image bytes", () => {
    appendAnswer(answer());

    const logPath = path.join(tempDir, "answers.jsonl");
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain("base64");
    expect(content).not.toContain("data:image");
    expect(fs.statSync(logPath).size).toBeLessThan(10_000);
  });

  it("normalizes shipped screenshot and transcript rows to the final shape", () => {
    const logPath = path.join(tempDir, "answers.jsonl");
    const legacyRows = [
      {
        timestamp: "2025-08-13T10:00:00Z",
        screenshotPath: "/path/to/legacy.png",
        answer: "Legacy screenshot",
        sessionID: "legacy-session",
        model: "legacy-model",
        error: "old warning",
        durationMs: 100,
      },
      {
        timestamp: "2025-08-13T10:01:00Z",
        source: "transcript",
        screenshotPath: "",
        answer: "Legacy transcript",
        sessionID: "legacy-session",
        model: "legacy-model",
        durationMs: 200,
      },
    ];
    fs.writeFileSync(
      logPath,
      `${legacyRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const records = readRecent(2);
    expect(records).toEqual([
      answer({
        answer: "Legacy screenshot",
        durationMs: 100,
        screenshotPaths: ["/path/to/legacy.png"],
      }),
      answer({
        timestamp: "2025-08-13T10:01:00Z",
        source: "meeting",
        screenshotPaths: [],
        answer: "Legacy transcript",
        durationMs: 200,
      }),
    ]);
    expect(Object.hasOwn(records[0] ?? {}, "sessionID")).toBe(false);
    expect(Object.hasOwn(records[0] ?? {}, "model")).toBe(false);
    expect(Object.hasOwn(records[0] ?? {}, "error")).toBe(false);
  });

  it("skips malformed and unsupported rows", () => {
    const logPath = path.join(tempDir, "answers.jsonl");
    fs.writeFileSync(
      logPath,
      [
        "not json",
        JSON.stringify({ source: "other" }),
        JSON.stringify(answer({ answer: "Valid" })),
      ].join("\n"),
    );

    expect(readRecent(10).map((record) => record.answer)).toEqual(["Valid"]);
  });
});
