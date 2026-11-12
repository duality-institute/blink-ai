import { describe, expect, it } from "bun:test";
import type { PopupMeetingPayload } from "../ipc";
import {
  emitMeeting,
  emitTranscript,
  openPopup,
} from "./popup-test-harness";

const ACTIVE_MEETING: PopupMeetingPayload = {
  meeting: true,
  meetingStarting: false,
  asking: false,
  showTranscript: true,
  screenshotCount: 0,
};

describe("popup Meeting transcript", () => {
  it("keeps transcript pinned after narrow reflow while rendering untrusted CJK safely", async () => {
    const { browser, page } = await openPopup();
    try {
      expect(await page.locator("#transcript-panel").isVisible()).toBe(false);
      await emitMeeting(page, ACTIVE_MEETING);
      expect(await page.locator("#transcript-toggle").count()).toBe(0);
      expect(await page.locator("#transcript-panel").isVisible()).toBe(true);

      await emitTranscript(page, {
        reset: true,
        volatile: [],
        changed: [
          { id: "them:0", speaker: "them", text: "How would you shard this table?" },
          { id: "you:1", speaker: "you", text: "<img src=x onerror=alert(1)>" },
        ],
      });
      expect(await page.locator(".transcript-line").count()).toBe(2);
      expect(
        await page
          .locator(".transcript-line")
          .nth(0)
          .locator(".transcript-speaker")
          .textContent(),
      ).toBe("Them");
      expect(
        await page
          .locator(".transcript-line")
          .nth(1)
          .locator(".transcript-speaker")
          .textContent(),
      ).toBe("You");
      expect(await page.locator("#transcript-panel img").count()).toBe(0);
      expect(
        await page
          .locator(".transcript-line")
          .nth(1)
          .locator(".transcript-text")
          .textContent(),
      ).toBe("<img src=x onerror=alert(1)>");

      await emitTranscript(page, {
        reset: false,
        volatile: [],
        changed: [
          {
            id: "them:2",
            speaker: "them",
            text: "Walk me through consistency when two replicas accept the same key at once.",
          },
          { id: "you:3", speaker: "you", text: "I would use optimistic concurrency." },
          {
            id: "them:4",
            speaker: "them",
            text: "에이전트 오케스트레이션 현황 및 미래 계획을 설명해 주시겠어요?",
          },
        ],
      });
      expect(await page.locator(".transcript-line").count()).toBe(5);

      await page.setViewportSize({ width: 360, height: 320 });
      await page.waitForFunction(() => {
        const panel = document.getElementById("transcript-scroll");
        return (
          panel !== null &&
          panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1
        );
      });
      const transcriptLayout = await page.evaluate(() => {
        const panel = document.getElementById("transcript-scroll");
        const text = document.querySelector(".transcript-text");
        if (panel === null || text === null) {
          return {
            pinned: false,
            overflowing: false,
            wordBreak: "missing",
            overflowWrap: "missing",
            pageOverflow: true,
          };
        }
        const style = getComputedStyle(text);
        return {
          pinned: panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1,
          overflowing: panel.scrollHeight > panel.clientHeight,
          wordBreak: style.wordBreak,
          overflowWrap: style.overflowWrap,
          pageOverflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      expect(transcriptLayout.overflowing).toBe(true);
      expect(transcriptLayout.pinned).toBe(true);
      expect(transcriptLayout.wordBreak).toBe("keep-all");
      expect(transcriptLayout.overflowWrap).toBe("break-word");
      expect(transcriptLayout.pageOverflow).toBe(false);

      await emitMeeting(page, { ...ACTIVE_MEETING, showTranscript: false });
      expect(await page.locator("#transcript-panel").isVisible()).toBe(true);

      await emitMeeting(page, {
        ...ACTIVE_MEETING,
        meeting: false,
        showTranscript: false,
      });
      expect(await page.locator("#transcript-toggle").count()).toBe(0);
      expect(await page.locator("#transcript-panel").isVisible()).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("revises a line in place, swaps partials, and clears on reset", async () => {
    const { browser, page } = await openPopup();
    try {
      await emitMeeting(page, ACTIVE_MEETING);

      await emitTranscript(page, {
        reset: false,
        changed: [{ id: "them:0", speaker: "them", text: "Tell me about" }],
        volatile: [{ id: "you:9", speaker: "you", text: "partial words" }],
      });
      expect(await page.locator(".transcript-line").count()).toBe(2);
      expect(await page.locator(".transcript-line.is-partial").count()).toBe(1);

      // A revised final line must replace its predecessor, never stack beside it.
      await emitTranscript(page, {
        reset: false,
        changed: [
          { id: "them:0", speaker: "them", text: "Tell me about your backend." },
        ],
        volatile: [],
      });
      expect(await page.locator(".transcript-line").count()).toBe(1);
      expect(
        await page.locator(".transcript-line").nth(0).locator(".transcript-text").textContent(),
      ).toBe("Tell me about your backend.");

      await emitTranscript(page, { reset: true, changed: [], volatile: [] });
      expect(await page.locator(".transcript-line").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("stops auto-scrolling once the user scrolls back through history", async () => {
    const { browser, page } = await openPopup();
    try {
      await emitMeeting(page, ACTIVE_MEETING);
      await emitTranscript(page, {
        reset: true,
        volatile: [],
        changed: Array.from({ length: 60 }, (_, index) => ({
          id: `them:${index}`,
          speaker: "them" as const,
          text: `Line number ${index} of the meeting transcript.`,
        })),
      });

      await page.evaluate(() => {
        document.getElementById("transcript-scroll")!.scrollTop = 0;
      });
      await emitTranscript(page, {
        reset: false,
        volatile: [],
        changed: [{ id: "them:99", speaker: "them", text: "A newly spoken line." }],
      });

      expect(
        await page.evaluate(
          () => document.getElementById("transcript-scroll")!.scrollTop,
        ),
      ).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
