import type { AnswerKind } from "./answer-client";

/**
 * Monitor questions are short-lived, so stale screenshots help less than they
 * confuse. Both windows must stay under BLINK_MEETING_IDLE_MINUTES (120): the
 * gateway deletes an idle session at that point, and a desktop whose own window
 * is longer would keep asking into a conversation the server already dropped.
 */
export const MONITOR_IDLE_MS = 30 * 60_000;
export const MEETING_IDLE_MS = 60 * 60_000;

/**
 * Images dominate the context window, so cap what one conversation accumulates.
 * The count is the meaningful limit — a model pays per image, not per byte — and
 * the byte ceiling only catches unusually heavy captures.
 */
export const SESSION_IMAGE_LIMIT = 35;
export const SESSION_IMAGE_BYTES_LIMIT = 40 * 1024 * 1024;

export type SessionCapacity = {
  readonly images: number;
  readonly bytes: number;
};

export function sessionLimitReached(used: SessionCapacity): boolean {
  return used.images >= SESSION_IMAGE_LIMIT || used.bytes >= SESSION_IMAGE_BYTES_LIMIT;
}

/** A forgotten Meeting would otherwise record and bill for the rest of the day. */
export const MEETING_BUDGET_MS = 3 * 60 * 60_000;
export const MEETING_WARNING_MS = 15 * 60_000;

export type MeetingTimeLeft = {
  readonly remainingMs: number;
  readonly warning: boolean;
  readonly expired: boolean;
};

export function meetingTimeLeft(startedAt: number, now: number): MeetingTimeLeft {
  const elapsed = Math.max(0, now - startedAt);
  const remainingMs = Math.max(0, MEETING_BUDGET_MS - elapsed);
  return {
    remainingMs,
    warning: remainingMs <= MEETING_WARNING_MS,
    expired: remainingMs === 0,
  };
}

export function idleWindowMs(mode: AnswerKind): number {
  return mode === "monitor" ? MONITOR_IDLE_MS : MEETING_IDLE_MS;
}

export function shouldResetSession(input: {
  readonly mode: AnswerKind;
  readonly lastAskAt: number | null;
  readonly now: number;
}): boolean {
  if (input.lastAskAt === null) return false;
  return input.now - input.lastAskAt >= idleWindowMs(input.mode);
}
