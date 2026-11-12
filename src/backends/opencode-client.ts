import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import type {
  AnswerCallbacks,
  VisionCapabilityResult,
} from "../core/answer-client";
import { runOpenCodeTurn, type ReconciledAnswer } from "./opencode-turn";
import { usageFromMessageInfo } from "./opencode-usage";

type Client = ReturnType<typeof createOpencodeClient>;

export type OpenCodeAnswerInput = {
  readonly kind: "monitor" | "meeting";
  readonly message?: string;
  readonly text?: string;
  readonly imagePaths: readonly string[];
  readonly prompt?: string;
};

export type OpenCodeClientOptions = {
  readonly baseUrl: string;
  readonly password: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly projectDirectory: string;
  readonly prompts: {
    readonly monitor: string;
    readonly meeting: string;
  };
};

const SessionSchema = z.object({ id: z.string().min(1) });
const MessagesSchema = z.array(
  z.object({
    info: z
      .object({
        id: z.string(),
        role: z.string(),
        time: z.object({ completed: z.number().optional() }).loose().optional(),
        error: z.unknown().optional(),
      })
      .loose(),
    parts: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .readonly(),
  }),
);

export const DISABLED_TOOLS: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(
    [
      "bash", "edit", "write", "patch", "multiedit", "task", "webfetch",
      "todowrite", "todoread", "read", "grep", "glob", "list",
    ].map((tool) => [tool, false]),
  ),
);

// Only the newest assistant message created by this turn counts, and only once
// it completed without error: an earlier answer or a partial one must never
// pass for success, or the caller would discard context it still needs.
function currentTurnAnswer(
  messages: z.infer<typeof MessagesSchema>,
  priorMessageIDs: ReadonlySet<string>,
): ReconciledAnswer {
  const message = messages.findLast(
    ({ info }) => info.role === "assistant" && !priorMessageIDs.has(info.id),
  );
  if (message?.info.time?.completed === undefined) return { text: "" };
  if (message.info.error !== undefined) return { text: "" };
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  const usage = usageFromMessageInfo(message.info);
  return usage === undefined ? { text } : { text, usage };
}

export class OpenCodeClient {
  private readonly client: Client;
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly model: OpenCodeClientOptions["model"];
  private readonly projectDirectory: string;
  private readonly prompts: OpenCodeClientOptions["prompts"];
  private sessionID: string | undefined;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password;
    this.model = options.model;
    this.projectDirectory = options.projectDirectory;
    this.prompts = options.prompts;
    const authorization =
      "Basic " + Buffer.from(`opencode:${options.password}`).toString("base64");
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      throwOnError: true,
      headers: { Authorization: authorization },
    });
  }

  async answer(
    input: OpenCodeAnswerInput,
    callbacks: AnswerCallbacks,
  ): Promise<void> {
    if (callbacks.signal?.aborted) {
      callbacks.onError?.("aborted");
      return;
    }
    const sessionID = await this.ensureSession();
    const parts = await this.parts(input);
    const priorMessageIDs = new Set(
      (await this.messages(sessionID)).map((message) => message.info.id),
    );
    await runOpenCodeTurn(
      {
        baseUrl: this.baseUrl,
        password: this.password,
        directory: this.projectDirectory,
        sessionID,
        ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
        sendPrompt: async (signal) => {
          // Not promptAsync: it returns 204 but never runs the model, leaving the
          // assistant message empty so the turn waits forever for events.
          await this.client.session.prompt({
            path: { id: sessionID },
            body: { model: this.model, tools: DISABLED_TOOLS, parts },
            signal,
            ...this.requestContext(),
          });
        },
        reconcile: async (signal) =>
          currentTurnAnswer(
            await this.messages(sessionID, signal),
            priorMessageIDs,
          ),
        abort: () => this.abortSession(sessionID),
      },
      callbacks,
    );
  }

  async resetSession(): Promise<string> {
    await this.discardSession();
    this.sessionID = await this.createSession();
    return this.sessionID;
  }

  async discardSession(): Promise<void> {
    const sessionID = this.sessionID;
    this.sessionID = undefined;
    if (sessionID === undefined) return;
    try {
      await this.client.session.delete({
        path: { id: sessionID },
        ...this.requestContext(),
      });
    } catch {
      return;
    }
  }

  async checkVisionCapability(): Promise<VisionCapabilityResult> {
    const response = await this.client.config.providers(this.requestContext());
    const provider = response.data?.providers.find(
      (candidate) => candidate.id === this.model.providerID,
    );
    const model = provider?.models[this.model.modelID];
    if (
      this.model.providerID.toLowerCase() === "deepseek" ||
      model?.capabilities.input.image !== true
    ) {
      return {
        ok: false,
        reason: `Model not vision-capable/found: ${this.model.providerID}/${this.model.modelID}`,
      };
    }
    return { ok: true };
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionID === undefined) this.sessionID = await this.createSession();
    return this.sessionID;
  }

  private async createSession(): Promise<string> {
    const response = await this.client.session.create({
      body: { title: "Blink answer" },
      ...this.requestContext(),
    });
    const parsed = SessionSchema.safeParse(response.data);
    if (!parsed.success) throw new Error("session.create returned no id");
    return parsed.data.id;
  }

  private requestContext(): {
    readonly query: { readonly directory: string };
    readonly headers: Readonly<Record<string, string>>;
  } {
    return {
      query: { directory: this.projectDirectory },
      headers: {
        "x-opencode-directory": encodeURIComponent(this.projectDirectory),
      },
    };
  }

  private async parts(input: OpenCodeAnswerInput): Promise<
    Array<
      | { type: "file"; mime: "image/png"; filename: string; url: string }
      | { type: "text"; text: string }
    >
  > {
    const parts: Awaited<ReturnType<OpenCodeClient["parts"]>> = [];
    for (const imagePath of input.imagePaths) {
      const image = await fs.promises.readFile(imagePath);
      parts.push({
        type: "file",
        mime: "image/png",
        filename: path.basename(imagePath),
        url: `data:image/png;base64,${image.toString("base64")}`,
      });
    }
    const prompt =
      input.prompt ??
      (input.kind === "monitor" ? this.prompts.monitor : this.prompts.meeting);
    const transcript = input.kind === "meeting" ? input.text?.trim() : undefined;
    parts.push({
      type: "text",
      text:
        transcript === undefined || transcript.length === 0
          ? prompt
          : `${prompt}\n\nMeeting transcript:\n${transcript}`,
    });
    if (input.message?.trim()) parts.push({ type: "text", text: input.message.trim() });
    return parts;
  }

  private async messages(
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof MessagesSchema>> {
    const response = await this.client.session.messages({
      path: { id: sessionID },
      ...(signal === undefined ? {} : { signal }),
      ...this.requestContext(),
    });
    const parsed = MessagesSchema.safeParse(response.data);
    if (!parsed.success) throw new Error("session.messages returned an unexpected shape");
    return parsed.data;
  }

  private async abortSession(sessionID: string): Promise<void> {
    try {
      await this.client.session.abort({
        path: { id: sessionID },
        ...this.requestContext(),
      });
    } catch {
      return;
    }
  }
}
