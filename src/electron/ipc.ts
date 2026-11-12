/**
 * IPC contract: channel names and payload types shared by main and renderer.
 * This module is importable from both Electron main process and renderer.
 * Contains ONLY type definitions and constants — no runtime electron imports.
 */

import type { TranscriptSpeaker } from "../core/transcript-history";
import type { AnswerComplete, AnswerDelta, AnswerError } from "../core/types";
import type { PermissionKind, PermissionStates } from "./welcome-steps";

export const CHANNEL_DISMISS = "blink:dismiss";
export const CHANNEL_ABORT = "blink:abort";
export const CHANNEL_POPUP_LOAD_HEADER = "blink:popup-load-header";
export const CHANNEL_POPUP_HEADER_CHANGED = "blink:popup-header-changed";
export const CHANNEL_POPUP_SET_PRIVACY = "blink:popup-set-privacy";
export const CHANNEL_POPUP_PRIVACY_CHANGED = "blink:popup-privacy-changed";
export const CHANNEL_POPUP_MEETING_CHANGED = "blink:popup-meeting-changed";
export const CHANNEL_POPUP_ASK_MEETING = "blink:popup-ask-meeting";
export const CHANNEL_POPUP_SET_DRAFT = "blink:popup-set-draft";
export const CHANNEL_POPUP_SET_MODE = "blink:popup-set-mode";
export const CHANNEL_POPUP_MONITORING_CHANGED =
  "blink:popup-monitoring-changed";

export type BlinkMode = "off" | "monitor" | "meeting";
export const CHANNEL_TRANSCRIPT_UPDATE = "blink:transcript-update";

export interface PopupMonitoringPayload {
  monitoring: boolean;
  monitoringStarting: boolean;
}

export interface PopupMeetingPayload {
  /** Epoch ms the meeting started, so the popup can tick elapsed time itself. */
  startedAt?: number;
  meeting: boolean;
  meetingStarting: boolean;
  asking: boolean;
  showTranscript: boolean;
  screenshotCount: number;
  screenshotBytes?: number;
  imageContextBusy?: boolean;
}

export interface TranscriptLine {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
}

/**
 * Incremental because a long meeting accumulates thousands of lines; resending
 * the whole transcript on every 150ms flush would grow with the square of the
 * session length.
 */
export interface TranscriptUpdatePayload {
  /** Finalized lines to insert or revise, keyed by id, in speech order. */
  changed: TranscriptLine[];
  /** Speech still being recognized; replaces the previous volatile lines. */
  volatile: TranscriptLine[];
  /** Set when a new session begins and the renderer must drop what it has. */
  reset: boolean;
}

export interface PopupHeaderPayload
  extends PopupMonitoringPayload,
    PopupMeetingPayload {
  hideFromCapture: boolean;
  lastError?: string;
  draftText?: string;
}

export const CHANNEL_ANSWER_START = "blink:answer-start";

export interface AnswerStartPayload {
  source: "monitor" | "meeting";
  title: string;
  detectedAt: string;
}

export const CHANNEL_ANSWER_DELTA = "blink:answer-delta";

export const CHANNEL_ANSWER_DONE = "blink:answer-done";

export interface AnswerDonePayload extends AnswerComplete {
  durationMs: number;
  cancelled: boolean;
  sessionRenewed?: boolean;
  submittedText?: string;
}

export const CHANNEL_ANSWER_ERROR = "blink:answer-error";


export const CHANNEL_PRESENTER_LOAD = "blink:presenter-load";
export const CHANNEL_PRESENTER_SAVE = "blink:presenter-save";
export const CHANNEL_PRESENTER_DISMISS = "blink:presenter-dismiss";
export const CHANNEL_PRESENTER_SET_PRIVACY = "blink:presenter-set-privacy";
export const CHANNEL_PRESENTER_PRIVACY_CHANGED =
  "blink:presenter-privacy-changed";
export const CHANNEL_PRESENTER_SCROLL = "blink:presenter-scroll";
export const CHANNEL_SETTINGS_LOAD_PROMPTS = "blink:settings-load-prompts";
export const CHANNEL_SETTINGS_SAVE_PROMPTS = "blink:settings-save-prompts";
export const CHANNEL_SETTINGS_LOAD_ANSWERS = "blink:settings-load-answers";
export const CHANNEL_SETTINGS_DISMISS = "blink:settings-dismiss";
export const CHANNEL_SETTINGS_LOAD_TRANSCRIPTS = "blink:settings-load-transcripts";
export const CHANNEL_SETTINGS_READ_TRANSCRIPT = "blink:settings-read-transcript";
export const CHANNEL_SETTINGS_SHOW_TAB = "blink:settings-show-tab";
export const CHANNEL_WELCOME_LOAD = "blink:welcome-load";
export const CHANNEL_WELCOME_REQUEST = "blink:welcome-request";
export const CHANNEL_WELCOME_RESTART = "blink:welcome-restart";
export const CHANNEL_WELCOME_DISMISS = "blink:welcome-dismiss";

export type PresenterScrollDirection = "up" | "down";

export interface PresenterStatePayload {
  markdown: string;
  hideFromCapture: boolean;
}

export type SettingsTab = "prompts" | "answers" | "transcripts";

export type PromptsPayload = {
  /** Empty means Blink uses the built-in default. */
  readonly monitorPrompt: string;
  readonly meetingPrompt: string;
  readonly monitorDefault: string;
  readonly meetingDefault: string;
};

export type AnswerLogEntry = {
  readonly timestamp: string;
  readonly source: "monitor" | "meeting";
  readonly answer: string;
  readonly durationMs: number;
};

export type TranscriptSessionEntry = {
  readonly file: string;
  readonly day: string;
  readonly startedAt: string;
  readonly lineCount: number;
  readonly byteSize: number;
  readonly matchCount: number;
};

export interface SettingsAPI {
  loadPrompts(): Promise<PromptsPayload>;
  savePrompts(prompts: {
    readonly monitorPrompt: string;
    readonly meetingPrompt: string;
  }): Promise<void>;
  loadAnswers(): Promise<readonly AnswerLogEntry[]>;
  loadTranscripts(query: string): Promise<readonly TranscriptSessionEntry[]>;
  readTranscript(file: string): Promise<string>;
  dismiss(): void;
  onShowTab(callback: (tab: SettingsTab) => void): void;
}

export interface WelcomeAPI {
  load(): Promise<PermissionStates>;
  request(kind: PermissionKind): Promise<PermissionStates>;
  restart(): void;
  dismiss(): void;
}

export interface PresenterAPI {
  load(): Promise<PresenterStatePayload>;
  save(markdown: string): Promise<void>;
  dismiss(): void;
  setPrivacy(hidden: boolean): void;
  onPrivacyChanged(callback: (hidden: boolean) => void): void;
  onScroll(callback: (direction: PresenterScrollDirection) => void): void;
}

export interface BlinkAPI {
  loadHeader(): Promise<PopupHeaderPayload>;
  onHeaderChanged(callback: (header: PopupHeaderPayload) => void): void;
  onAnswerStart(callback: (payload: AnswerStartPayload) => void): void;
  onAnswerDelta(callback: (payload: AnswerDelta) => void): void;
  onAnswerDone(callback: (payload: AnswerDonePayload) => void): void;
  onAnswerError(callback: (payload: AnswerError) => void): void;
  abort(): void;
  dismiss(): void;
  setPrivacy(hidden: boolean): void;
  onPrivacyChanged(callback: (hidden: boolean) => void): void;
  setMode(mode: BlinkMode): void;
  askMeeting(): void;
  setDraft(text: string): void;
  onMeetingChanged(callback: (state: PopupMeetingPayload) => void): void;
  onMonitoringChanged(callback: (state: PopupMonitoringPayload) => void): void;
  onTranscriptUpdate(
    callback: (payload: TranscriptUpdatePayload) => void,
  ): void;
}
