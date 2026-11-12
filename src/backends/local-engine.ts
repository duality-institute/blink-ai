import type {
  AnswerCallbacks,
  AnswerKind,
  AnswerPrompts,
  VisionCapabilityResult,
} from "../core/answer-client";
import { DEFAULT_MEETING_PROMPT, DEFAULT_MONITOR_PROMPT } from "../core/prompts";

export function resolvePrompts(prompts: AnswerPrompts): AnswerPrompts {
  return {
    monitor: prompts.monitor.trim() || DEFAULT_MONITOR_PROMPT,
    meeting: prompts.meeting.trim() || DEFAULT_MEETING_PROMPT,
  };
}

/** One Ask as every local engine (Claude, Codex, OpenCode) receives it. */
export type LocalAnswerInput = {
  readonly kind: AnswerKind;
  readonly imagePaths: readonly string[];
  readonly message?: string;
  /** Meeting transcript; ignored for Monitor. */
  readonly text?: string;
  /** Instruction for this Ask; engines fall back to their configured prompt. */
  readonly prompt?: string;
};

/**
 * A session-bearing answer engine. Session IDs live only in memory; the main
 * runtime decides when to reset, so engines never rotate or retry on their own.
 */
export interface LocalEngine {
  answer(input: LocalAnswerInput, callbacks: AnswerCallbacks): Promise<void>;
  resetSession(): Promise<string>;
  discardSession(): Promise<void>;
  checkVisionCapability(): Promise<VisionCapabilityResult>;
}

/** Instruction text, with the Meeting transcript appended as OpenCode does. */
export function answerInstruction(
  input: LocalAnswerInput,
  prompts: AnswerPrompts,
): string {
  const prompt = input.prompt ?? prompts[input.kind];
  const transcript = input.kind === "meeting" ? input.text?.trim() : undefined;
  return transcript === undefined || transcript === ""
    ? prompt
    : `${prompt}\n\nMeeting transcript:\n${transcript}`;
}

/** Shields the caller from engines that report twice or never: exactly one onDone or onError. */
export class TerminalCallbacks {
  private readonly callbacks: AnswerCallbacks;
  settled = false;

  constructor(callbacks: AnswerCallbacks) {
    this.callbacks = callbacks;
  }

  forEngine(signal: AbortSignal): AnswerCallbacks {
    return {
      onDelta: (text) => {
        if (!this.settled) this.callbacks.onDelta?.(text);
      },
      onDone: (text, durationMs, metadata) => {
        if (this.settled) return;
        this.settled = true;
        this.callbacks.onDone?.(text, durationMs, metadata);
      },
      onError: (message) => this.onError(message),
      signal,
    };
  }

  onError(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.callbacks.onError?.(message);
  }
}

/** The user's typed message, or undefined when blank. */
export function answerMessage(input: LocalAnswerInput): string | undefined {
  const message = input.message?.trim();
  return message === undefined || message === "" ? undefined : message;
}
