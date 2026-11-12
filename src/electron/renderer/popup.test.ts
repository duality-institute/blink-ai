import { describe, expect, it } from "bun:test";
import type { PopupHeaderPayload, PopupMeetingPayload } from "../ipc";
import {
  emitAnswerDone,
  emitAnswerStart,
  emitMeeting,
  emitMonitoring,
  openPopup,
} from "./popup-test-harness";

const EMPTY_MEETING: PopupMeetingPayload = {
  meeting: true,
  meetingStarting: false,
  asking: false,
  showTranscript: true,
  screenshotCount: 0,
};

describe("popup controls", () => {
  it("accepts a text-only Monitor Ask and preserves edits made during the answer", async () => {
    const { browser, page } = await openPopup({ header: {
      hideFromCapture: true, monitoring: true, monitoringStarting: false,
      meeting: false, meetingStarting: false, asking: false,
      showTranscript: false, screenshotCount: 0,
    } });
    try {
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      await page.locator("#message-input").fill("First question");
      expect(await page.locator("#ask-meeting").isEnabled()).toBe(true);
      await page.locator("#ask-meeting").click();
      await page.locator("#message-input").fill("Follow-up question");
      await emitAnswerDone(page, {
        type: "complete", text: "Answer", durationMs: 1, reconciled: false,
        cancelled: false, submittedText: "First question",
      });
      expect(await page.locator("#message-input").inputValue()).toBe("Follow-up question");
      await emitAnswerDone(page, {
        type: "complete", text: "Next answer", durationMs: 1, reconciled: false,
        cancelled: false, submittedText: "Follow-up question",
      });
      expect(await page.locator("#message-input").inputValue()).toBe("");
    } finally { await browser.close(); }
  });

  it("shows shortcut notes in the footer and keeps Ask above the workspace", async () => {
    const { browser, page } = await openPopup();
    try {
      expect(await page.locator(".action-footer button").count()).toBe(0);
      expect(await page.locator(".action-footer kbd").allTextContents()).toEqual(["⇧⌘2", "⇧⌘1", "⇧⌘0", "⌃⌘↵", "⌘↑↓←→"]);
      expect(await page.locator("#meeting-context #ask-meeting").count()).toBe(1);
      await page.locator("#mode").selectOption("monitor");
      await emitMeeting(page, { ...EMPTY_MEETING, meeting: false, screenshotCount: 2, screenshotBytes: 1048576 });
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      await emitMonitoring(page, { monitoring: true, monitoringStarting: false });
      expect(await page.locator("#transcript-panel").isVisible()).toBe(false);
      expect(await page.locator("#context-copy").textContent()).toBe("2 screenshots staged");
      expect(await page.locator("#ask-meeting").isEnabled()).toBe(true);
      await emitMeeting(page, { ...EMPTY_MEETING, screenshotCount: 2, asking: true });
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      await emitMeeting(page, { ...EMPTY_MEETING, screenshotCount: 2, imageContextBusy: true });
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      await emitMeeting(page, { ...EMPTY_MEETING, screenshotCount: 12 });
      expect(await page.locator("#ask-meeting").isEnabled()).toBe(true);
    } finally { await browser.close(); }
  });

  it("notes a renewed session on the answer that filled it, with nothing to click", async () => {
    const { browser, page } = await openPopup();
    const start = { source: "meeting", title: "Meeting transcript", detectedAt: "2026-10-06T12:00:00Z" } as const;
    try {
      await emitMeeting(page, { ...EMPTY_MEETING, screenshotCount: 2 });
      expect(await page.locator("#session-note").isVisible()).toBe(false);

      await emitAnswerStart(page, start);
      await emitAnswerDone(page, {
        type: "complete", text: "Answer", reconciled: false, durationMs: 1, cancelled: false, sessionRenewed: true,
      });
      expect(await page.locator("#session-note").isVisible()).toBe(true);
      expect(await page.locator("#session-note").textContent()).toBe(
        "Session limit reached — new session started.",
      );
      expect(await page.locator("#meeting-context button").count()).toBe(1);
      expect(await page.locator("#ask-meeting").isEnabled()).toBe(true);

      await emitAnswerStart(page, start);
      expect(await page.locator("#session-note").isVisible()).toBe(false);
    } finally { await browser.close(); }
  });

  it("warns only inside the final fifteen minutes of the Meeting budget", async () => {
    const { browser, page } = await openPopup();
    const threeHours = 3 * 60 * 60_000;
    try {
      const startedAt = async (agoMs: number): Promise<void> => {
        await emitMeeting(page, { ...EMPTY_MEETING, startedAt: Date.now() - agoMs });
      };

      await startedAt(0);
      expect(await page.locator("#meeting-budget").isVisible()).toBe(false);

      await startedAt(threeHours - 15 * 60_000 - 5_000);
      expect(await page.locator("#meeting-budget").isVisible()).toBe(false);

      await startedAt(threeHours - 10 * 60_000);
      expect(await page.locator("#meeting-budget").isVisible()).toBe(true);
      expect(await page.locator("#meeting-budget-text").textContent()).toContain(
        "stops in 10:00",
      );

      await emitMeeting(page, { ...EMPTY_MEETING, meeting: false, startedAt: Date.now() - threeHours });
      expect(await page.locator("#meeting-budget").isVisible()).toBe(false);
    } finally { await browser.close(); }
  });

  it("loads final product state and drives Monitor, Meeting, and Ask", async () => {
    const { browser, page } = await openPopup();
    try {
      expect(await page.locator(".product-context").textContent()).toBe(
        "AI meeting copilot",
      );
      expect(await page.locator("#backend-label").count()).toBe(0);
      expect(await page.locator("#model-label").count()).toBe(0);
      expect(await page.locator("#mode").inputValue()).toBe("off");
      expect(await page.locator("#meeting-context").isVisible()).toBe(false);

      await page.locator("#mode").selectOption("meeting");
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __blinkTest: { modeRequests: string[] };
              }
            ).__blinkTest.modeRequests,
        ),
      ).toEqual(["meeting"]);

      await emitMeeting(page, {
        ...EMPTY_MEETING,
        meeting: false,
        meetingStarting: true,
      });
      expect(await page.locator("#mode").inputValue()).toBe("meeting");
      expect(await page.locator("#mode").isDisabled()).toBe(true);
      expect(await page.locator("#mode-label").textContent()).toBe(
        "Starting…",
      );
      expect(await page.locator("#meeting-context").isVisible()).toBe(true);
      expect(await page.locator("#context-copy").textContent()).toBe(
        "Preparing private context…",
      );
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);

      await emitMeeting(page, EMPTY_MEETING);
      expect(await page.locator("#mode").isDisabled()).toBe(false);
      expect(await page.locator("#mode-label").textContent()).toBe("Meeting");
      expect(await page.locator("#transcript-panel").isVisible()).toBe(true);
      expect(
        await page.evaluate(() =>
          getComputedStyle(
            document.getElementById("transcript-lines")!,
            "::before",
          ).content.replace(/"/g, ""),
        ),
      ).toBe("Waiting for speech…");

      await emitMeeting(page, {
        ...EMPTY_MEETING,
        screenshotCount: 2,
      });
      expect(await page.locator("#context-copy").textContent()).toBe(
        "2 screenshots staged",
      );
      expect(await page.locator("#ask-meeting").isEnabled()).toBe(true);
      await page.locator("#ask-meeting").click();
      expect(await page.locator("#ask-meeting").textContent()).toBe("Asking…");
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __blinkTest: { askRequests: number };
              }
            ).__blinkTest.askRequests,
        ),
      ).toBe(1);

      await page.locator("#mode").selectOption("monitor");
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __blinkTest: { modeRequests: string[] };
              }
            ).__blinkTest.modeRequests,
        ),
      ).toEqual(["meeting", "monitor"]);

      const refreshed: PopupHeaderPayload = {
        hideFromCapture: false,
        monitoring: true,
        monitoringStarting: false,
        meeting: false,
        meetingStarting: false,
        asking: false,
        showTranscript: false,
              screenshotCount: 0,
      };
      await page.evaluate((header) => {
        (
          window as unknown as {
            __blinkTest: {
              onHeaderChanged?: (payload: PopupHeaderPayload) => void;
            };
          }
        ).__blinkTest.onHeaderChanged?.(header);
      }, refreshed);
      expect(await page.locator("#mode").inputValue()).toBe("monitor");
      expect(await page.locator("#mode-label").textContent()).toBe("Monitor");
      expect(await page.locator("#meeting-context").isVisible()).toBe(true);
      expect(await page.locator("#context-copy").textContent()).toBe(
        "No screenshots yet",
      );
      expect(await page.locator("#ask-meeting").isDisabled()).toBe(true);
      expect(await page.locator("#privacy-label").textContent()).toBe("Visible");
      expect(await page.locator("#usage-pill").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("marks recovered and stopped answers without any account status", async () => {
    const { browser, page } = await openPopup();
    const start = { source: "monitor", title: "1 screenshot", detectedAt: "2026-10-06T12:00:00Z" } as const;
    try {
      await emitMonitoring(page, { monitoring: true, monitoringStarting: false });
      expect(await page.locator(".status-group .pill").count()).toBe(2);

      await emitAnswerStart(page, start);
      await emitAnswerDone(page, {
        type: "complete", text: "Recovered answer", reconciled: true, durationMs: 1, cancelled: false,
      });
      expect(await page.locator("#reconciled-pill").isVisible()).toBe(true);
      expect(await page.locator("#stopped-pill").isVisible()).toBe(false);

      await emitAnswerStart(page, start);
      await emitAnswerDone(page, {
        type: "complete", text: "", reconciled: false, durationMs: 0, cancelled: true,
      });
      expect(await page.locator("#stopped-pill").isVisible()).toBe(true);
      expect(await page.locator("#reconciled-pill").isVisible()).toBe(false);
      expect(await page.locator(".status-group .pill:visible").count()).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("keeps active controls and Meeting context inside both popup widths", async () => {
    const { browser, page } = await openPopup();
    try {
      await emitMeeting(page, {
        ...EMPTY_MEETING,
        screenshotCount: 123,
      });
      await page.evaluate(() => {
        document.getElementById("mode-control")?.classList.add("is-monitor");
        document.getElementById("privacy")?.classList.add("is-private");
        const stop = document.getElementById("abort");
        if (stop !== null) stop.hidden = false;
      });

      const wide = await page.evaluate(() => {
        const title = document.querySelector(".window-title");
        const titleRange = document.createRange();
        if (title !== null) titleRange.selectNodeContents(title);
        const titleText = titleRange.getBoundingClientRect();
        const monitor = document
          .getElementById("mode-control")
          ?.getBoundingClientRect();
        return {
          titleRight: titleText.right,
          monitorLeft: monitor?.left ?? 0,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(wide.monitorLeft - wide.titleRight).toBeGreaterThanOrEqual(4);
      expect(wide.scrollWidth).toBe(420);

      await page.setViewportSize({ width: 360, height: 320 });
      const compact = await page.evaluate(() => {
        const identity = document.querySelector(".identity");
        const actions = document
          .querySelector(".header-actions")
          ?.getBoundingClientRect();
        const ask = document.getElementById("ask-meeting")?.getBoundingClientRect();
        return {
          identityDisplay:
            identity === null ? "missing" : getComputedStyle(identity).display,
          actionsLeft: actions?.left ?? 0,
          actionsRight: actions?.right ?? 0,
          askHeight: ask?.height ?? 0,
          askRight: ask?.right ?? 0,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(compact.identityDisplay).toBe("none");
      expect(compact.actionsLeft).toBeGreaterThanOrEqual(12);
      expect(compact.actionsRight).toBeLessThanOrEqual(348);
      expect(compact.askHeight).toBeGreaterThanOrEqual(30);
      expect(compact.askRight).toBeLessThanOrEqual(348);
      expect(compact.scrollWidth).toBe(360);
    } finally {
      await browser.close();
    }
  });
});
