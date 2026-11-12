import * as fs from "node:fs";
import type {
  AnswerCallbacks,
  AnswerClient,
  AnswerKind,
  AnswerPrompts,
  MeetingContext,
  VisionCapabilityResult,
} from "../core/answer-client";
import { assertImageUploadLimits, STAGING_OVERHEAD_BYTES } from "../core/upload-limits";
import { MAX_USER_MESSAGE_LENGTH, OptionalUserMessageSchema } from "../core/user-message";
import {
  resolvePrompts,
  TerminalCallbacks,
  type LocalAnswerInput,
  type LocalEngine,
} from "./local-engine";

export { createLocalAnswerClient, LocalAnswerConfigError } from "./local-client-factory";

export type LocalAnswerClientOptions = {
  /** Backend name used in user-facing errors, e.g. "Claude". */
  readonly label: string;
  /** One session-bearing engine per mode; they never share a conversation. */
  readonly engines: Readonly<Record<AnswerKind, LocalEngine>>;
  readonly prompts: AnswerPrompts;
  /** Releases shared resources (the OpenCode server) after sessions end. */
  readonly release?: () => Promise<void>;
};

type ActiveAnswer = {
  readonly controller: AbortController;
  /** Settles when the engine has stopped, whatever the outcome. */
  readonly stopped: Promise<void>;
};

/** An Ask as the runtime submits it, before admission. */
type AskRequest = {
  readonly kind: AnswerKind;
  readonly imagePaths: readonly string[];
  readonly message?: string | undefined;
  readonly transcript?: string | undefined;
};

export class AskAdmissionError extends Error {
  override readonly name = "AskAdmissionError";
}

export class LocalAnswerClient implements AnswerClient {
  private readonly label: string;
  private readonly engines: Readonly<Record<AnswerKind, LocalEngine>>;
  private readonly release: () => Promise<void>;
  private prompts: AnswerPrompts;
  private active: ActiveAnswer | null = null;
  private disposal: Promise<void> | null = null;

  constructor(options: LocalAnswerClientOptions) {
    this.label = options.label;
    this.engines = options.engines;
    this.prompts = options.prompts;
    this.release = options.release ?? (() => Promise.resolve());
  }

  answerMonitor(
    screenshotPaths: readonly string[],
    callbacks: AnswerCallbacks,
    message?: string,
  ): Promise<void> {
    return this.answer({ kind: "monitor", imagePaths: screenshotPaths, message }, callbacks);
  }

  answerMeeting(context: MeetingContext, callbacks: AnswerCallbacks): Promise<void> {
    return this.answer(
      {
        kind: "meeting",
        imagePaths: context.screenshotPaths,
        message: context.message,
        transcript: context.transcript,
      },
      callbacks,
    );
  }

  async resetSession(kind: AnswerKind): Promise<string> {
    if (this.disposal !== null) throw new Error(`${this.label} client is disposed`);
    await this.abort();
    return this.engines[kind].resetSession();
  }

  async endSession(kind: AnswerKind): Promise<void> {
    await this.abort();
    await this.engines[kind].discardSession();
  }

  async abort(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    active.controller.abort();
    await active.stopped;
  }

  checkVisionCapability(): Promise<VisionCapabilityResult> {
    return this.engines.monitor.checkVisionCapability();
  }

  /** Applies to the next Ask; sessions and their history are kept. */
  setPrompts(prompts: AnswerPrompts): void {
    this.prompts = resolvePrompts(prompts);
  }

  dispose(): Promise<void> {
    this.disposal ??= this.shutdown();
    return this.disposal;
  }

  private async shutdown(): Promise<void> {
    await this.abort();
    try {
      await Promise.all([
        this.engines.monitor.discardSession(),
        this.engines.meeting.discardSession(),
      ]);
    } finally {
      await this.release();
    }
  }

  private async answer(
    request: AskRequest,
    callbacks: AnswerCallbacks,
  ): Promise<void> {
    const terminal = new TerminalCallbacks(callbacks);
    if (this.disposal !== null) {
      terminal.onError(`${this.label} client is disposed`);
      return;
    }
    if (this.active !== null) {
      terminal.onError(`${this.label} is already processing an answer`);
      return;
    }
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callbacks.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callbacks.signal?.aborted) controller.abort();

    const running = this.run(request, terminal, controller.signal);
    const active: ActiveAnswer = {
      controller,
      // A throwing caller callback belongs to the asker, not to abort().
      stopped: running.then(noop, noop),
    };
    this.active = active;
    try {
      await running;
    } finally {
      callbacks.signal?.removeEventListener("abort", onCallerAbort);
      if (this.active === active) this.active = null;
    }
  }

  private async run(
    request: AskRequest,
    terminal: TerminalCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const prompt = this.prompts[request.kind];
    try {
      const input = await admit(request, prompt);
      if (signal.aborted) {
        terminal.onError("aborted");
        return;
      }
      await this.engines[request.kind].answer(input, terminal.forEngine(signal));
    } catch (error) {
      if (terminal.settled) throw error;
      terminal.onError(signal.aborted ? "aborted" : formatError(error));
      return;
    }
    if (!terminal.settled) {
      terminal.onError(
        signal.aborted ? "aborted" : `${this.label} completed without an answer`,
      );
    }
  }
}

async function admit(request: AskRequest, prompt: string): Promise<LocalAnswerInput> {
  const typed = OptionalUserMessageSchema.safeParse(request.message);
  if (!typed.success) {
    throw new AskAdmissionError(`Message exceeds ${MAX_USER_MESSAGE_LENGTH} characters.`);
  }
  const message = typed.data;
  const transcript = request.transcript?.trim();
  const text = transcript === undefined || transcript === "" ? undefined : transcript;
  if (message === undefined && text === undefined && request.imagePaths.length === 0) {
    throw new AskAdmissionError("Requests need a message, transcript, or screenshot");
  }
  const sizes = await Promise.all(
    request.imagePaths.map(async (imagePath) => (await fs.promises.stat(imagePath)).size),
  );
  const contextBytes = [prompt, text, message].reduce(
    (total, part) => total + Buffer.byteLength(part ?? "", "utf8"),
    STAGING_OVERHEAD_BYTES,
  );
  assertImageUploadLimits(sizes, contextBytes);
  return {
    kind: request.kind,
    imagePaths: request.imagePaths,
    prompt,
    ...(message === undefined ? {} : { message }),
    ...(text === undefined ? {} : { text }),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noop(): void {}
