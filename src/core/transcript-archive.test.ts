import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listTranscriptSessions,
  readTranscriptSession,
} from "./transcript-archive";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-transcripts-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function write(file: string, body: string): void {
  fs.writeFileSync(path.join(directory, file), body, "utf8");
}

describe("transcript archive", () => {
  it("lists sessions newest first with a parsed day and start time", () => {
    write("2026-09-01-091500.md", "# Blink transcript\n\n**Them** (00:01) hello\n\n");
    write("2026-09-03-140000.md", "# Blink transcript\n\n**You** (00:02) later\n\n");

    const sessions = listTranscriptSessions(directory);
    expect(sessions.map((entry) => entry.file)).toEqual([
      "2026-09-03-140000.md",
      "2026-09-01-091500.md",
    ]);
    expect(sessions[0]?.day).toBe("2026-09-03");
    expect(sessions[0]?.startedAt).toBe("14:00:00");
    expect(sessions[0]?.lineCount).toBe(1);
  });

  it("returns nothing when no transcript directory exists yet", () => {
    expect(listTranscriptSessions(path.join(directory, "absent"))).toEqual([]);
  });

  it("ignores files that are not transcript sessions", () => {
    write("notes.md", "not a session");
    write("2026-09-01-091500.md", "**Them** (00:01) real\n\n");
    expect(listTranscriptSessions(directory)).toHaveLength(1);
  });

  it("keeps only sessions containing the query and counts the hits", () => {
    write("2026-09-01-091500.md", "**Them** (00:01) sharding the table\n\n");
    write("2026-09-02-091500.md", "**Them** (00:01) unrelated chatter\n\n");
    write("2026-09-03-091500.md", "**You** (00:01) sharding, then sharding again\n\n");

    const sessions = listTranscriptSessions(directory, "sharding");
    expect(sessions.map((entry) => entry.file)).toEqual([
      "2026-09-03-091500.md",
      "2026-09-01-091500.md",
    ]);
    expect(sessions[0]?.matchCount).toBe(2);
  });

  it("matches regardless of the case the user typed", () => {
    write("2026-09-01-091500.md", "**Them** (00:01) Postgres replication\n\n");
    expect(listTranscriptSessions(directory, "POSTGRES")).toHaveLength(1);
  });

  it("reads a session body back", () => {
    write("2026-09-01-091500.md", "# Blink transcript\n\n**Them** (00:01) hello\n\n");
    expect(readTranscriptSession(directory, "2026-09-01-091500.md")?.markdown).toContain(
      "hello",
    );
  });

  it("removes the redundant title from an older session", () => {
    write(
      "2026-09-01-091500.md",
      "# Blink transcript\n\nStarted 2026-09-01 09:15:00\n\n**Them** (00:01) hello\n\n",
    );

    expect(readTranscriptSession(directory, "2026-09-01-091500.md")?.markdown).toBe(
      "Started 2026-09-01 09:15:00\n\n**Them** (00:01) hello\n\n",
    );
  });

  it("refuses to read outside the transcript directory", () => {
    expect(readTranscriptSession(directory, "../../../etc/passwd")).toBeUndefined();
    expect(readTranscriptSession(directory, "notes.md")).toBeUndefined();
  });

  it("accepts the suffix used when two sessions start in the same second", () => {
    write("2026-09-01-091500.md", "**Them** (00:01) first\n\n");
    write("2026-09-01-091500-2.md", "**Them** (00:01) second\n\n");
    expect(listTranscriptSessions(directory)).toHaveLength(2);
  });
});
