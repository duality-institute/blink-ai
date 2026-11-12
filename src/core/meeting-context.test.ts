import { describe, expect, it } from "bun:test";
import { MeetingContextBuffer } from "./meeting-context";

describe("MeetingContextBuffer", () => {
  it("rejects the eleventh capture before changing context", () => {
    const context = new MeetingContextBuffer();
    for (let i = 0; i < 10; i++) context.stageScreenshot(`${i}.png`);
    expect(() => context.stageScreenshot("extra.png")).toThrow(/10/);
    expect(context.staged()).toHaveLength(10);
  });

  it("rejects an image above 8 MiB and leaves staged images intact", () => {
    const context = new MeetingContextBuffer();
    context.stageScreenshot("small.png", 1024);
    expect(() => context.stageScreenshot("large.png", 8 * 1024 * 1024 + 1)).toThrow(/8 MiB/);
    expect(context.staged()).toEqual(["small.png"]);
  });

  it("includes transcript bytes and upload overhead in the staged budget", () => {
    const context = new MeetingContextBuffer();
    for (const name of ["a", "b"]) context.stageScreenshot(`${name}.png`, 8 * 1024 * 1024);
    expect(() => context.stageScreenshot("second.png", 3 * 1024 * 1024, 2 * 1024 * 1024)).toThrow(/20 MiB/);
    expect(context.staged()).toEqual(["a.png", "b.png"]);
    expect(context.clear()).toEqual(["a.png", "b.png"]);
    expect(context.stageScreenshot("fresh.png", 6 * 1024 * 1024)).toBe(true);
  });

  it("stages each screenshot once", () => {
    const context = new MeetingContextBuffer();

    expect(context.stageScreenshot("first.png")).toBe(true);
    expect(context.stageScreenshot("first.png")).toBe(false);
    expect(context.stageScreenshot("second.png")).toBe(true);

    expect(context.staged()).toEqual(["first.png", "second.png"]);
    expect(context.summary()).toEqual({ screenshotCount: 2, screenshotBytes: 0 });
  });

  it("keeps screenshots captured while an answer was streaming", () => {
    const context = new MeetingContextBuffer();
    context.stageScreenshot("submitted.png");
    const submitted = context.staged();
    context.stageScreenshot("captured-during-answer.png");

    context.removeScreenshots(submitted);

    expect(context.staged()).toEqual(["captured-during-answer.png"]);
  });

  it("returns staged files for cleanup when cleared", () => {
    const context = new MeetingContextBuffer();
    context.stageScreenshot("capture.png");

    expect(context.clear()).toEqual(["capture.png"]);
    expect(context.staged()).toEqual([]);
  });
});
