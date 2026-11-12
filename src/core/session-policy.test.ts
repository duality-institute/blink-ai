import { describe, expect, it } from "bun:test";
import {
  MEETING_BUDGET_MS,
  MEETING_IDLE_MS,
  MEETING_WARNING_MS,
  meetingTimeLeft,
  MONITOR_IDLE_MS,
  SESSION_IMAGE_BYTES_LIMIT,
  SESSION_IMAGE_LIMIT,
  sessionLimitReached,
  shouldResetSession,
} from "./session-policy";
import { MAX_ASK_BODY_BYTES, MAX_SCREENSHOTS_PER_ASK } from "./upload-limits";

const NOW = 1_700_000_000_000;

describe("shouldResetSession", () => {
  it("keeps a conversation that has never been asked", () => {
    for (const mode of ["monitor", "meeting"] as const) {
      expect(shouldResetSession({ mode, lastAskAt: null, now: NOW })).toBe(false);
    }
  });

  it("expires Monitor after 30 idle minutes and Meeting after 60", () => {
    expect(MONITOR_IDLE_MS).toBe(30 * 60_000);
    expect(MEETING_IDLE_MS).toBe(60 * 60_000);

    const monitorEdge = { mode: "monitor", now: NOW } as const;
    expect(
      shouldResetSession({ ...monitorEdge, lastAskAt: NOW - MONITOR_IDLE_MS + 1 }),
    ).toBe(false);
    expect(
      shouldResetSession({ ...monitorEdge, lastAskAt: NOW - MONITOR_IDLE_MS }),
    ).toBe(true);

    const meetingEdge = { mode: "meeting", now: NOW } as const;
    expect(
      shouldResetSession({ ...meetingEdge, lastAskAt: NOW - MONITOR_IDLE_MS }),
    ).toBe(false);
    expect(
      shouldResetSession({ ...meetingEdge, lastAskAt: NOW - MEETING_IDLE_MS }),
    ).toBe(true);
  });

  it("resets before the gateway sweeps, so no Ask lands in a deleted session", () => {
    const gatewaySweepMs = 120 * 60_000;
    expect(MONITOR_IDLE_MS).toBeLessThan(gatewaySweepMs);
    expect(MEETING_IDLE_MS).toBeLessThan(gatewaySweepMs);
  });
});

describe("sessionLimitReached", () => {
  it("stays false until a limit is actually reached", () => {
    expect(SESSION_IMAGE_LIMIT).toBe(35);
    expect(SESSION_IMAGE_BYTES_LIMIT).toBe(40 * 1024 * 1024);
    expect(
      sessionLimitReached({
        images: SESSION_IMAGE_LIMIT - 1,
        bytes: SESSION_IMAGE_BYTES_LIMIT - 1,
      }),
    ).toBe(false);
  });

  it("is reached on the screenshot count", () => {
    expect(sessionLimitReached({ images: SESSION_IMAGE_LIMIT, bytes: 0 })).toBe(true);
  });

  it("is reached on total bytes even when few screenshots were sent", () => {
    expect(
      sessionLimitReached({ images: 2, bytes: SESSION_IMAGE_BYTES_LIMIT }),
    ).toBe(true);
  });

  it("never lets one Ask exceed a whole session", () => {
    expect(MAX_SCREENSHOTS_PER_ASK).toBe(10);
    expect(MAX_SCREENSHOTS_PER_ASK).toBeLessThan(SESSION_IMAGE_LIMIT);
    expect(MAX_ASK_BODY_BYTES).toBeLessThanOrEqual(SESSION_IMAGE_BYTES_LIMIT);
  });
});

describe("meetingTimeLeft", () => {
  it("runs for three hours and warns for the final fifteen minutes", () => {
    expect(MEETING_BUDGET_MS).toBe(3 * 60 * 60_000);
    expect(MEETING_WARNING_MS).toBe(15 * 60_000);

    expect(meetingTimeLeft(NOW, NOW)).toEqual({
      remainingMs: MEETING_BUDGET_MS,
      warning: false,
      expired: false,
    });

    const warnAt = NOW + MEETING_BUDGET_MS - MEETING_WARNING_MS;
    expect(meetingTimeLeft(NOW, warnAt - 1).warning).toBe(false);
    expect(meetingTimeLeft(NOW, warnAt)).toEqual({
      remainingMs: MEETING_WARNING_MS,
      warning: true,
      expired: false,
    });
  });

  it("expires once the budget is spent and never reports negative time", () => {
    const endsAt = NOW + MEETING_BUDGET_MS;
    expect(meetingTimeLeft(NOW, endsAt - 1).expired).toBe(false);
    expect(meetingTimeLeft(NOW, endsAt)).toEqual({
      remainingMs: 0,
      warning: true,
      expired: true,
    });
    expect(meetingTimeLeft(NOW, endsAt + 60_000)).toEqual({
      remainingMs: 0,
      warning: true,
      expired: true,
    });
  });

  it("treats a clock that jumped backwards as a full budget", () => {
    expect(meetingTimeLeft(NOW, NOW - 60_000).remainingMs).toBe(MEETING_BUDGET_MS);
  });
});
