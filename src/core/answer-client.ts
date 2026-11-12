export type AnswerUsage = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
};

export type AnswerMetadata = {
  readonly reconciled: boolean;
  readonly sessionID: string;
  readonly usage?: AnswerUsage;
};

export interface AnswerCallbacks {
  readonly onDelta?: (text: string) => void;
  readonly onDone?: (
    text: string,
    durationMs: number,
    metadata: AnswerMetadata,
  ) => void;
  readonly onError?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export type VisionCapabilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type AnswerKind = "monitor" | "meeting";

export type MeetingContext = {
  readonly transcript?: string;
  readonly message?: string;
  readonly screenshotPaths: readonly string[];
};

export type AnswerPrompts = {
  readonly monitor: string;
  readonly meeting: string;
};

export interface AnswerClient {
  answerMonitor(
    screenshotPaths: readonly string[],
    callbacks: AnswerCallbacks,
    message?: string,
  ): Promise<void>;
  answerMeeting(
    context: MeetingContext,
    callbacks: AnswerCallbacks,
  ): Promise<void>;
  resetSession(kind: AnswerKind): Promise<string>;
  endSession(kind: AnswerKind): Promise<void>;
  abort(): Promise<void>;
  checkVisionCapability(): Promise<VisionCapabilityResult>;
  setPrompts(prompts: AnswerPrompts): void;
  dispose(): Promise<void>;
}
