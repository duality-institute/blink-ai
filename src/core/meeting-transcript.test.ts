import { describe, expect, it } from "bun:test";
import { MeetingTranscriptCursor } from "./meeting-transcript";
import type { TranscriptHistoryLine } from "./transcript-history";

function line(
  speaker: "them" | "you",
  text: string,
  startMs: number,
): TranscriptHistoryLine {
  return { id: `${speaker}:${startMs}`, speaker, text, startMs };
}

describe("MeetingTranscriptCursor", () => {
  it("sends the whole meeting on the first ask", () => {
    const cursor = new MeetingTranscriptCursor();
    const chunk = cursor.chunk([
      line("them", "How would you shard this?", 3_000),
      line("you", "By tenant id.", 15_000),
    ]);

    expect(chunk.text).toBe(
      [
        "Transcript 00:03-00:15",
        "",
        "Them (00:03): How would you shard this?",
        "You (00:15): By tenant id.",
      ].join("\n"),
    );
    expect(chunk.hasNewSpeech).toBe(true);
  });

  it("never repeats a line the model already received", () => {
    const cursor = new MeetingTranscriptCursor();
    const first = [line("them", "Opening question.", 1_000)];
    cursor.markSubmitted(cursor.chunk(first).lineIds);

    const chunk = cursor.chunk([...first, line("you", "Later answer.", 300_000)]);

    expect(chunk.text).not.toContain("Opening question.");
    expect(chunk.text).toContain("Later answer.");
    expect(chunk.text).toContain("new since the last ask");
  });

  it("carries the in-progress line without consuming it", () => {
    const cursor = new MeetingTranscriptCursor();
    const chunk = cursor.chunk(
      [line("them", "Settled speech.", 1_000)],
      [line("you", "half a sen", 9_000)],
    );
    cursor.markSubmitted(chunk.lineIds);

    expect(chunk.text).toContain("You (00:09, in progress): half a sen");
    expect(chunk.lineIds).toEqual(["them:1000"]);

    const next = cursor.chunk([
      line("them", "Settled speech.", 1_000),
      line("you", "half a sentence, finished.", 9_000),
    ]);
    expect(next.text).toContain("half a sentence, finished.");
  });

  it("resends the same lines when an ask failed", () => {
    const cursor = new MeetingTranscriptCursor();
    const lines = [line("them", "Unanswered question.", 2_000)];

    cursor.chunk(lines);
    const retry = cursor.chunk(lines);

    expect(retry.text).toContain("Unanswered question.");
    expect(retry.hasNewSpeech).toBe(true);
  });

  it("says so plainly when only screenshots are new", () => {
    const cursor = new MeetingTranscriptCursor();
    cursor.markSubmitted(cursor.chunk([line("them", "Already sent.", 0)]).lineIds);

    const chunk = cursor.chunk([line("them", "Already sent.", 0)]);

    expect(chunk.text).toBe("No new speech since the last ask.");
    expect(chunk.lineIds).toEqual([]);
    expect(chunk.hasNewSpeech).toBe(false);
  });

  it("replays the meeting after the gateway dropped the conversation", () => {
    const cursor = new MeetingTranscriptCursor();
    const lines = [
      line("them", "First half.", 0),
      line("you", "Second half.", 60_000),
    ];
    cursor.markSubmitted(cursor.chunk(lines).lineIds);

    cursor.reset();
    const chunk = cursor.chunk(lines);

    expect(chunk.text).toContain("First half.");
    expect(chunk.text).toContain("Second half.");
    expect(cursor.submittedCount).toBe(0);
  });

  it("switches to hours once a meeting runs long", () => {
    const cursor = new MeetingTranscriptCursor();
    const chunk = cursor.chunk([line("them", "Still going.", 3_725_000)]);

    expect(chunk.text).toContain("Them (1:02:05): Still going.");
  });
});
