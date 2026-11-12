import * as fs from "node:fs";
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

export interface ClaudeClientOptions {
  readonly prompts: AnswerPrompts;
  readonly projectDir: string;
  /** Omitted means Claude Code's own configured model. */
  readonly model?: string | undefined;
  readonly command?: string;
  runner?(options: JsonlProcessOptions): Promise<void>;
}

/** Session state one turn writes into; reset swaps in a new object. */
type Session = { id: string | undefined };

export class ClaudeClient implements LocalEngine {
  private readonly prompts: AnswerPrompts;
  private readonly model: string | undefined;
  private readonly projectDir: string;
  private readonly command: string;
  private readonly runner: (options: JsonlProcessOptions) => Promise<void>;
  private session: Session = { id: undefined };
  private activeController: AbortController | null = null;

  constructor(options: ClaudeClientOptions) {
    this.prompts = options.prompts;
    this.model = options.model;
    this.projectDir = options.projectDir;
    this.command = options.command ?? "claude";
    this.runner = options.runner ?? runJsonlProcess;
  }

  checkVisionCapability(): Promise<VisionCapabilityResult> {
    if (findExecutable(this.command) !== undefined) return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: false,
      reason: "Claude Code CLI not found. Install Claude Code and authenticate it first.",
    });
  }

  async resetSession(): Promise<string> {
    await this.discardSession();
    return "new Claude session";
  }

  discardSession(): Promise<void> {
    this.activeController?.abort();
    this.session = { id: undefined };
    return Promise.resolve();
  }

  async answer(input: LocalAnswerInput, callbacks: AnswerCallbacks): Promise<void> {
    if (this.activeController !== null) {
      callbacks.onError?.("Claude is already processing an answer");
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeController = controller;
    const onParentAbort = (): void => controller.abort();
    callbacks.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (callbacks.signal?.aborted) controller.abort();

    const session = this.session;
    let sessionId = session.id;
    let streamedText = "";
    let finalText = "";
    let failure: string | undefined;
    const discover = (value: unknown): void => {
      const discovered = stringValue(value);
      if (discovered === undefined) return;
      sessionId = discovered;
      session.id = discovered;
    };

    try {
      await this.runner({
        command: this.command,
        args: this.buildArgs(sessionId),
        cwd: this.projectDir,
        input: await this.buildInput(input),
        signal: controller.signal,
        onJson: (value) => {
          const message = record(value);
          const type = stringValue(message["type"]);
          if (type === "system" && message["subtype"] === "init") {
            discover(message["session_id"]);
            return;
          }
          if (type === "stream_event") {
            const event = record(message["event"]);
            const delta = record(event["delta"]);
            if (delta["type"] !== "text_delta") return;
            const text = stringValue(delta["text"]);
            if (text === undefined || text === "") return;
            streamedText += text;
            callbacks.onDelta?.(text);
            return;
          }
          if (type !== "result") return;
          discover(message["session_id"]);
          const result = stringValue(message["result"]);
          if (message["is_error"] === true || message["subtype"] !== "success") {
            failure = result ?? "Claude failed";
          } else if (result !== undefined) {
            finalText = result;
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
      callbacks.onError?.("Claude completed without an answer");
      return;
    }
    callbacks.onDone?.(answer, Date.now() - startedAt, {
      reconciled: false,
      sessionID: sessionId ?? "claude",
    });
  }

  private async buildInput(input: LocalAnswerInput): Promise<string> {
    const content: Array<
      | {
          type: "image";
          source: { type: "base64"; media_type: "image/png"; data: string };
        }
      | { type: "text"; text: string }
    > = [];
    for (const imagePath of input.imagePaths) {
      const png = await fs.promises.readFile(imagePath);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: png.toString("base64"),
        },
      });
    }
    content.push({ type: "text", text: answerInstruction(input, this.prompts) });
    const typed = answerMessage(input);
    if (typed !== undefined) content.push({ type: "text", text: typed });
    const message = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };
    return `${JSON.stringify(message)}\n`;
  }

  private buildArgs(sessionId: string | undefined): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
    ];
    if (this.model !== undefined) args.push("--model", this.model);
    if (sessionId !== undefined) args.push("--resume", sessionId);
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
