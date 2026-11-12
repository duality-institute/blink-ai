import { Buffer } from "node:buffer";
import ky from "ky";
import { z } from "zod";
import type { AnswerUsage } from "../core/answer-client";
import { usageFromMessageInfo } from "./opencode-usage";

export type MessagePartDeltaEvent = {
  readonly type: "message.part.delta";
  readonly sessionID: string;
  readonly messageID: string;
  readonly partID: string;
  readonly field: string;
  readonly delta: string;
};

export type MessageUpdatedEvent = {
  readonly type: "message.updated";
  readonly sessionID: string;
  readonly info: {
    readonly time?: { readonly completed?: number };
    readonly usage?: AnswerUsage;
    readonly [key: string]: unknown;
  };
};

export type SessionStatusEvent = {
  readonly type: "session.status";
  readonly sessionID: string;
  readonly status: {
    readonly type: "idle" | "busy" | "retry";
    readonly [key: string]: unknown;
  };
};

export type SessionErrorEvent = {
  readonly type: "session.error";
  readonly sessionID?: string;
  readonly error?: unknown;
};

export type OpenCodeEvent =
  | { readonly type: "server.connected" }
  | MessagePartDeltaEvent
  | MessageUpdatedEvent
  | SessionStatusEvent
  | SessionErrorEvent
  | { readonly type: string; readonly raw: unknown };

export type OpenCodeEventSubscription = {
  readonly password: string;
  // OpenCode scopes its event bus per project directory: subscribing without
  // this yields only server-level events, never the session's messages.
  readonly directory: string;
  readonly signal?: AbortSignal;
};

const EnvelopeSchema = z.object({ type: z.string() });
const DeltaSchema = z.object({
  type: z.literal("message.part.delta"),
  properties: z.object({
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string(),
    field: z.string(),
    delta: z.string(),
  }),
});
const MessageUpdatedSchema = z.object({
  type: z.literal("message.updated"),
  properties: z.object({
    sessionID: z.string(),
    info: z
      .object({
        time: z.object({ completed: z.number().optional() }).optional(),
      })
      .loose(),
  }),
});
const SessionStatusSchema = z.object({
  type: z.literal("session.status"),
  properties: z.object({
    sessionID: z.string(),
    status: z
      .object({ type: z.enum(["idle", "busy", "retry"]) })
      .loose(),
  }),
});
const SessionErrorSchema = z.object({
  type: z.literal("session.error"),
  properties: z.object({
    sessionID: z.string().optional(),
    error: z.unknown().optional(),
  }),
});

export class OpenCodeEventError extends Error {
  override readonly name = "OpenCodeEventError";
}

export async function* subscribeOpenCodeEvents(
  baseUrl: string,
  subscription: OpenCodeEventSubscription,
): AsyncGenerator<OpenCodeEvent> {
  const credentials = Buffer.from(
    `opencode:${subscription.password}`,
  ).toString("base64");
  let response: Response;
  try {
    response = await ky.get(`${baseUrl.replace(/\/$/, "")}/event`, {
      searchParams: { directory: subscription.directory },
      headers: {
        Accept: "text/event-stream",
        Authorization: `Basic ${credentials}`,
        "x-opencode-directory": encodeURIComponent(subscription.directory),
      },
      retry: 0,
      timeout: false,
      throwHttpErrors: false,
      ...(subscription.signal === undefined
        ? {}
        : { signal: subscription.signal }),
    });
  } catch (error) {
    if (subscription.signal?.aborted) return;
    throw error;
  }
  if (!response.ok) {
    throw new OpenCodeEventError(
      `OpenCode event stream failed (${response.status})`,
    );
  }
  if (response.body === null) {
    throw new OpenCodeEventError("OpenCode event stream returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!subscription.signal?.aborted) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (subscription.signal?.aborted) return;
        throw error;
      }
      if (chunk.done) return;
      buffer = `${buffer}${decoder.decode(chunk.value, { stream: true })}`.replace(
        /\r\n/g,
        "\n",
      );
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const event = parseFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (event !== null) yield event;
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseOpenCodeEvent(payload: unknown): OpenCodeEvent {
  const envelope = EnvelopeSchema.safeParse(payload);
  if (!envelope.success) return { type: "unknown", raw: payload };
  switch (envelope.data.type) {
    case "server.connected":
      return { type: "server.connected" };
    case "message.part.delta": {
      const parsed = DeltaSchema.safeParse(payload);
      return parsed.success
        ? { type: parsed.data.type, ...parsed.data.properties }
        : { type: envelope.data.type, raw: payload };
    }
    case "message.updated": {
      const parsed = MessageUpdatedSchema.safeParse(payload);
      if (!parsed.success) return { type: envelope.data.type, raw: payload };
      const completed = parsed.data.properties.info.time?.completed;
      const usage = usageFromMessageInfo(parsed.data.properties.info);
      return {
        type: parsed.data.type,
        sessionID: parsed.data.properties.sessionID,
        info: {
          ...(completed === undefined ? {} : { time: { completed } }),
          ...(usage === undefined ? {} : { usage }),
        },
      };
    }
    case "session.status": {
      const parsed = SessionStatusSchema.safeParse(payload);
      return parsed.success
        ? { type: parsed.data.type, ...parsed.data.properties }
        : { type: envelope.data.type, raw: payload };
    }
    case "session.error": {
      const parsed = SessionErrorSchema.safeParse(payload);
      if (!parsed.success) return { type: envelope.data.type, raw: payload };
      const { error, sessionID } = parsed.data.properties;
      return {
        type: "session.error",
        ...(sessionID === undefined ? {} : { sessionID }),
        ...(error === undefined ? {} : { error }),
      };
    }
    default:
      return { type: envelope.data.type, raw: payload };
  }
}

function parseFrame(frame: string): OpenCodeEvent | null {
  const data = frame
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)));
  if (data.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return parseOpenCodeEvent(payload);
}
