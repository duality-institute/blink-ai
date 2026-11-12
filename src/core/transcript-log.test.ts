import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptLog } from "./transcript-log";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-transcript-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function log(): TranscriptLog {
  return new TranscriptLog(directory, new Date("2026-08-30T14:30:22"));
}

describe("TranscriptLog", () => {
  it("creates no file until a final line arrives", () => {
    const transcript = log();

    transcript.append({
      speaker: "them",
      text: "partial thought",
      startMs: 0,
      isFinal: false,
    });

    expect(fs.existsSync(transcript.filePath)).toBe(false);
    expect(transcript.lineCount).toBe(0);
  });

  it("writes start metadata once and appends speaker-stamped lines", () => {
    const transcript = log();

    transcript.append({
      speaker: "them",
      text: "How would you shard this table?",
      startMs: 12_000,
      isFinal: true,
    });
    transcript.append({
      speaker: "you",
      text: "By tenant id.",
      startMs: 78_500,
      isFinal: true,
    });

    expect(path.basename(transcript.filePath)).toBe("2026-08-30-143022.md");
    const contents = fs.readFileSync(transcript.filePath, "utf8");
    expect(contents).toBe(
      [
        "Started 2026-08-30 14:30:22",
        "",
        "**Them** (00:12) How would you shard this table?",
        "",
        "**You** (01:18) By tenant id.",
        "",
        "",
      ].join("\n"),
    );
    expect(transcript.lineCount).toBe(2);
  });

  it("ignores volatile revisions, blanks, and repeated finals", () => {
    const transcript = log();
    const line = {
      speaker: "them" as const,
      text: "Repeated line",
      startMs: 1_000,
      isFinal: true,
    };

    transcript.append(line);
    transcript.append(line);
    transcript.append({ ...line, text: "Repeated line revised" });
    transcript.append({ speaker: "you", text: "   ", startMs: 2_000, isFinal: true });
    transcript.append({
      speaker: "you",
      text: "volatile",
      startMs: 3_000,
      isFinal: false,
    });

    const body = fs.readFileSync(transcript.filePath, "utf8");
    expect(body.match(/Repeated line/g)).toHaveLength(1);
    expect(body).not.toContain("volatile");
    expect(transcript.lineCount).toBe(1);
  });

  it("never overwrites an existing session file", () => {
    const first = log();
    first.append({ speaker: "them", text: "first", startMs: 0, isFinal: true });

    const second = log();
    second.append({ speaker: "them", text: "second", startMs: 0, isFinal: true });

    expect(second.filePath).not.toBe(first.filePath);
    expect(fs.readFileSync(first.filePath, "utf8")).toContain("first");
    expect(fs.readFileSync(second.filePath, "utf8")).toContain("second");
  });
});
