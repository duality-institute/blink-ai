import type {
  AnswerCallbacks,
  AnswerPrompts,
  VisionCapabilityResult,
} from "../core/answer-client";
import {
  answerInstruction,
  answerMessage,
  type LocalAnswerInput,
  type LocalEngine,
} from "./local-engine";
import {
  findExecutable,
  ProcessAbortedError,
  runJsonlProcess,
  type JsonlProcessOptions,
} from "./process-runner";

export interface CodexClientOptions {
  readonly prompts: AnswerPrompts;
  readonly projectDir: string;
  /** Omitted means Codex's own configured model. */
  readonly model?: string | undefined;
  readonly command?: string;
  runner?(options: JsonlProcessOptions): Promise<void>;
}

/** Thread state one turn writes into; reset swaps in a new object. */
type Session = { id: string | undefined };

export class CodexClient implements LocalEngine {
  private readonly prompts: AnswerPrompts;
  private readonly model: string | undefined;
  private readonly projectDir: string;
  private readonly command: string;
  private readonly runner: (options: JsonlProcessOptions) => Promise<void>;
  private session: Session = { id: undefined };
  private activeController: AbortController | null = null;

  constructor(options: CodexClientOptions) {
    this.prompts = options.prompts;
    this.model = options.model;
    this.projectDir = options.projectDir;
    this.command = options.command ?? "codex";
    this.runner = options.runner ?? runJsonlProcess;
  }

  checkVisionCapability(): Promise<VisionCapabilityResult> {
    if (findExecutable(this.command) !== undefined) return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: false,
      reason: "Codex CLI not found. Install Codex and authenticate it first.",
    });
  }

  async resetSession(): Promise<string> {
    await this.discardSession();
    return "new Codex session";
  }

  discardSession(): Promise<void> {
    this.activeController?.abort();
    this.session = { id: undefined };
    return Promise.resolve();
  }

  async answer(input: LocalAnswerInput, callbacks: AnswerCallbacks): Promise<void> {
    if (this.activeController !== null) {
      callbacks.onError?.("Codex is already processing an answer");
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeController = controller;
    const onParentAbort = (): void => controller.abort();
    callbacks.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (callbacks.signal?.aborted) controller.abort();

    const session = this.session;
    let threadId = session.id;
    let streamedText = "";
    let finalText = "";
    let failure: string | undefined;

    try {
      await this.runner({
        command: this.command,
        args: this.buildArgs(input.imagePaths, threadId),
        cwd: this.projectDir,
        input: this.buildInput(input),
        signal: controller.signal,
        onJson: (value) => {
          const event = record(value);
          const type = stringValue(event["type"]);
          if (type === "thread.started") {
            const discovered = stringValue(event["thread_id"]);
            if (discovered !== undefined) {
              threadId = discovered;
              session.id = discovered;
            }
            return;
          }
          if (type === "item.updated" || type === "item.completed") {
            const item = record(event["item"]);
            if (item["type"] !== "agent_message") return;
            const nextText = stringValue(item["text"]);
            if (nextText === undefined) return;
            finalText = nextText;
            if (nextText.startsWith(streamedText)) {
              const delta = nextText.slice(streamedText.length);
              if (delta !== "") callbacks.onDelta?.(delta);
              streamedText = nextText;
            }
            return;
          }
          if (type === "turn.failed") {
            failure = errorMessage(event["error"]) ?? "Codex turn failed";
            return;
          }
          if (type === "error") {
            failure = stringValue(event["message"]) ?? "Codex failed";
          }
        },
      });
    } catch (error) {
      if (error instanceof ProcessAbortedError || controller.signal.aborted) {
        callbacks.onError?.("aborted");
      } else {
        callbacks.onError?.(failure ?? formatError(error));
      }
      return;
    } finally {
      callbacks.signal?.removeEventListener("abort", onParentAbort);
      if (this.activeController === controller) this.activeController = null;
    }

    if (controller.signal.aborted) {
      callbacks.onError?.("aborted");
      return;
    }
    if (failure !== undefined) {
      callbacks.onError?.(failure);
      return;
    }
    const answer = finalText !== "" ? finalText : streamedText;
    if (answer === "") {
      callbacks.onError?.("Codex completed without an answer");
      return;
    }
    callbacks.onDone?.(answer, Date.now() - startedAt, {
      reconciled: false,
      sessionID: threadId ?? "codex",
    });
  }

  private buildInput(input: LocalAnswerInput): string {
    const instruction = answerInstruction(input, this.prompts);
    const typed = answerMessage(input);
    return typed === undefined ? instruction : `${instruction}\n\nUser message:\n${typed}`;
  }

  /**
   * `--image` takes several values, so every image gets its own flag and `--`
   * ends options before the thread id and the `-` (read prompt from stdin).
   */
  private buildArgs(
    imagePaths: readonly string[],
    sessionId: string | undefined,
  ): string[] {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      this.projectDir,
    ];
    if (this.model !== undefined) args.push("--model", this.model);
    if (sessionId !== undefined) args.push("resume");
    for (const imagePath of imagePaths) args.push("--image", imagePath);
    args.push("--");
    if (sessionId !== undefined) args.push(sessionId);
    args.push("-");
    return args;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return stringValue(record(value)["message"]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
