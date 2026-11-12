import { describe, expect, it } from "bun:test";
import { TranscriptHistory } from "./transcript-history";

function segment(
  speaker: "them" | "you",
  text: string,
  startMs: number,
  isFinal = true,
): { speaker: "them" | "you"; text: string; startMs: number; endMs: number; isFinal: boolean } {
  return { speaker, text, startMs, endMs: startMs + 1_000, isFinal };
}

describe("TranscriptHistory", () => {
  it("retains an hour-old line so a long meeting keeps its full history", () => {
    const history = new TranscriptHistory();

    history.push(segment("them", "First thing said in the meeting.", 0));
    history.push(segment("them", "Something said an hour later.", 3_600_000));

    expect(history.lines().map((line) => line.text)).toEqual([
      "First thing said in the meeting.",
      "Something said an hour later.",
    ]);
  });

  it("drains each finalized line exactly once", () => {
    const history = new TranscriptHistory();
    history.push(segment("them", "one", 0));
    history.push(segment("you", "two", 1_000));

    expect(history.drain().changed.map((line) => line.text)).toEqual(["one", "two"]);
    expect(history.drain().changed).toEqual([]);
  });

  it("revises a line in place rather than appending a duplicate", () => {
    const history = new TranscriptHistory();
    history.push(segment("them", "How do you", 0));
    history.drain();
    history.push(segment("them", "How do you shard it?", 0));

    const delta = history.drain();
    expect(delta.changed).toHaveLength(1);
    expect(history.lines()).toHaveLength(1);
    expect(history.lines()[0]?.text).toBe("How do you shard it?");
  });

  it("replaces volatile speech per speaker and drops it once finalized", () => {
    const history = new TranscriptHistory();
    history.push(segment("you", "I was going", 0, false));
    history.push(segment("you", "I was going to say", 0, false));
    expect(history.drain().volatile.map((line) => line.text)).toEqual([
      "I was going to say",
    ]);

    history.push(segment("you", "I was going to say this.", 0));
    const delta = history.drain();
    expect(delta.volatile).toEqual([]);
    expect(delta.changed.map((line) => line.text)).toEqual([
      "I was going to say this.",
    ]);
  });

  it("ignores blank speech so the panel never shows empty rows", () => {
    const history = new TranscriptHistory();
    history.push(segment("them", "   ", 0));
    expect(history.size).toBe(0);
  });

  it("forgets everything when the session ends", () => {
    const history = new TranscriptHistory();
    history.push(segment("them", "one", 0));
    history.clear();
    expect(history.lines()).toEqual([]);
    expect(history.drain().changed).toEqual([]);
  });
});
