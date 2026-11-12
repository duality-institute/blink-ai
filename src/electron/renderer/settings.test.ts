import { describe, expect, it } from "bun:test";
import type { Page } from "playwright";
import { bridge, openSettings, showTabFromMain, type SettingsFixture } from "./settings-test-harness";

const FIXTURE: SettingsFixture = {
  prompts: {
    monitorPrompt: "",
    meetingPrompt: "Summarize decisions",
    monitorDefault: "Monitor default prompt",
    meetingDefault: "Meeting default prompt",
  },
  answers: [
    {
      timestamp: "2026-11-09T15:04:05.000Z",
      source: "monitor",
      answer: "Use a **hash index** for the lookup.",
      durationMs: 1200,
    },
  ],
  sessions: [
    {
      file: "2026-11-09-150405.md",
      day: "2026-11-09",
      startedAt: "15:04:05",
      lineCount: 2,
      byteSize: 64,
      matchCount: 0,
    },
  ],
  transcripts: { "2026-11-09-150405.md": "**Them:** How would you shard this table?" },
};

function ids(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.id));
}

describe("settings window", () => {
  it("switches among prompts, answers, and transcripts, loading each history once", async () => {
    const { browser, page } = await openSettings({ fixture: FIXTURE });
    try {
      expect(await ids(page, '[role="tab"]')).toEqual(["tab-prompts", "tab-answers", "tab-transcripts"]);
      expect(await ids(page, "main > section:visible")).toEqual(["panel-prompts"]);

      await page.locator("#tab-answers").click();
      expect(await ids(page, "main > section:visible")).toEqual(["panel-answers"]);
      expect(await page.locator("#tab-answers").getAttribute("aria-selected")).toBe("true");
      expect(await page.locator("#answers li").count()).toBe(1);

      await showTabFromMain(page, "transcripts");
      await page.locator("#tx-view strong").waitFor();
      expect(await ids(page, "main > section:visible")).toEqual(["panel-transcripts"]);
      expect(await page.locator("#tx-list .tx-item").count()).toBe(1);

      await page.locator("#tab-answers").click();
      const state = await bridge(page);
      expect(state.answerLoads).toBe(1);
      expect(state.transcriptQueries).toEqual([""]);
    } finally {
      await browser.close();
    }
  });

  it("saves a custom Monitor prompt and keeps the existing Meeting prompt", async () => {
    const { browser, page } = await openSettings({ fixture: FIXTURE });
    try {
      expect(await page.locator("#monitor-prompt").inputValue()).toBe("Monitor default prompt");
      expect(await page.locator("#meeting-custom").getAttribute("aria-checked")).toBe("true");

      await page.locator("#monitor-custom").click();
      await page.locator("#monitor-prompt").fill("  Answer in Korean  ");
      await page.locator("#save").click();
      await page.locator("#saved").waitFor();

      expect((await bridge(page)).saved).toEqual([
        { monitorPrompt: "Answer in Korean", meetingPrompt: "Summarize decisions" },
      ]);
    } finally {
      await browser.close();
    }
  });
});
