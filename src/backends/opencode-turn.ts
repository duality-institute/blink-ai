import type { AnswerCallbacks, AnswerUsage } from "../core/answer-client";
import {
  subscribeOpenCodeEvents,
  type OpenCodeEvent,
} from "./opencode-events";

export type ReconciledAnswer = {
  readonly text: string;
  readonly usage?: AnswerUsage;
};

export type OpenCodeTurnOptions = {
  readonly baseUrl: string;
  readonly password: string;
  readonly directory: string;
  readonly sessionID: string;
  readonly signal?: AbortSignal;
  readonly sendPrompt: (signal: AbortSignal) => Promise<void>;
  readonly reconcile: (signal: AbortSignal) => Promise<ReconciledAnswer>;
  readonly abort: () => Promise<void>;
};

type StreamState = { text: string; messageID?: string; usage?: AnswerUsage };
type EventResult = "continue" | "done" | { readonly error: string };
type StreamOutcome = "done" | "ended" | "aborted" | { readonly error: string };
type PromptFailure = { readonly ok: false; readonly error: unknown };
type PromptOutcome = { readonly ok: true } | PromptFailure;
type TurnOutcome =
  | ({ readonly kind: "done"; readonly reconciled: boolean } & ReconciledAnswer)
  | { readonly kind: "error"; readonly message: string };
type TurnContext = {
  readonly options: OpenCodeTurnOptions;
  readonly state: StreamState;
  readonly callbacks: AnswerCallbacks;
  readonly signal: AbortSignal;
};
type RunningTasks = {
  prompt?: Promise<PromptOutcome>;
  promptSettled: boolean;
  stream?: Promise<StreamOutcome>;
};

const ABORTED: TurnOutcome = { kind: "error", message: "aborted" };
const NO_ANSWER: TurnOutcome = {
  kind: "error",
  message: "The model returned no answer text. Please try asking again.",
};

function errorMessage(value: unknown): string {
  if (value === undefined) return "session error";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "session error";
  }
}

function failure(error: unknown): TurnOutcome {
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}

function processEvent(
  event: OpenCodeEvent,
  sessionID: string,
  state: StreamState,
  callbacks: AnswerCallbacks,
): EventResult {
  if (event.type === "message.part.delta" && "delta" in event) {
    if (event.sessionID !== sessionID) return "continue";
    if (state.messageID !== undefined && event.messageID !== state.messageID) {
      return "continue";
    }
    state.messageID ??= event.messageID;
    if (event.field === "text" && event.delta.length > 0) {
      state.text += event.delta;
      callbacks.onDelta?.(event.delta);
    }
    return "continue";
  }
  if (event.type === "message.updated" && "info" in event) {
    if (event.sessionID !== sessionID) return "continue";
    if (event.info.usage !== undefined) state.usage = event.info.usage;
    return event.info.time?.completed !== undefined ? "done" : "continue";
  }
  if (event.type === "session.status" && "status" in event) {
    return event.sessionID === sessionID && event.status.type === "idle"
      ? "done"
      : "continue";
  }
  if (event.type === "session.error" && !("raw" in event)) {
    if (event.sessionID !== undefined && event.sessionID !== sessionID) {
      return "continue";
    }
    return { error: errorMessage(event.error) };
  }
  return "continue";
}

async function consumeStream(
  events: AsyncGenerator<OpenCodeEvent>,
  first: OpenCodeEvent,
  context: TurnContext,
): Promise<StreamOutcome> {
  const { options, state, callbacks } = context;
  try {
    const initial = processEvent(first, options.sessionID, state, callbacks);
    if (initial !== "continue") return initial;
    for await (const event of events) {
      const result = processEvent(event, options.sessionID, state, callbacks);
      if (result !== "continue") return result;
    }
  } catch {
    // A dropped stream is recovered by reconnecting and reconciling.
  }
  return context.signal.aborted ? "aborted" : "ended";
}

async function reconnect(context: TurnContext): Promise<void> {
  const { options, state, callbacks, signal } = context;
  try {
    for await (const event of subscribeOpenCodeEvents(options.baseUrl, {
      password: options.password,
      directory: options.directory,
      signal,
    })) {
      if (processEvent(event, options.sessionID, state, callbacks) !== "continue") return;
    }
  } catch {
    return;
  }
}

function startReconnect(context: TurnContext): () => Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  context.signal.addEventListener("abort", stop, { once: true });
  const reconnecting = reconnect({ ...context, signal: controller.signal });
  return async () => {
    controller.abort();
    context.signal.removeEventListener("abort", stop);
    await reconnecting;
  };
}

async function settleTurn(
  context: TurnContext,
  stream: StreamOutcome,
  prompt: Promise<PromptOutcome>,
): Promise<TurnOutcome> {
  if (stream === "aborted") return ABORTED;
  if (typeof stream !== "string") return { kind: "error", message: stream.error };
  // The prompt request returns only once the server finished the turn, so the
  // answer is final only after it settles. A dropped stream keeps relaying
  // deltas through a fresh subscription meanwhile.
  const stopReconnect = stream === "ended" ? startReconnect(context) : undefined;
  let settled: PromptOutcome;
  try {
    settled = await prompt;
  } finally {
    await stopReconnect?.();
  }
  if (!settled.ok) return context.signal.aborted ? ABORTED : failure(settled.error);
  const { state } = context;
  // Streamed text never stands in for a missing reconciled answer: after a
  // dropped stream it may be partial.
  const reconciled =
    stream === "done" && state.text.length > 0
      ? undefined
      : await context.options.reconcile(context.signal);
  const text = reconciled === undefined ? state.text : reconciled.text;
  if (text.length === 0) return NO_ANSWER;
  const usage = reconciled?.usage ?? state.usage;
  return {
    kind: "done",
    text,
    reconciled: reconciled !== undefined,
    ...(usage === undefined ? {} : { usage }),
  };
}

async function executeTurn(
  context: TurnContext,
  running: RunningTasks,
): Promise<TurnOutcome> {
  const { options, signal } = context;
  const events = subscribeOpenCodeEvents(options.baseUrl, {
    password: options.password,
    directory: options.directory,
    signal,
  });
  const first = await events.next();
  if (first.done) {
    return signal.aborted ? ABORTED : failure("SSE closed before subscription established");
  }
  const prompt = options.sendPrompt(signal).then(
    (): PromptOutcome => ({ ok: true }),
    (error: unknown): PromptOutcome => ({ ok: false, error }),
  );
  running.prompt = prompt;
  void prompt.then(() => {
    running.promptSettled = true;
  });
  // Drain events while the synchronous prompt request is still running, so
  // deltas reach the caller as they stream instead of after completion.
  const stream = consumeStream(events, first.value, context);
  running.stream = stream;
  const promptFailure = prompt.then<StreamOutcome | PromptFailure>((settled) =>
    settled.ok ? stream : settled,
  );
  const winner = await Promise.race([stream, promptFailure]);
  if (typeof winner !== "string" && "ok" in winner) {
    return signal.aborted ? ABORTED : failure(winner.error);
  }
  return settleTurn(context, winner, prompt);
}

export async function runOpenCodeTurn(
  options: OpenCodeTurnOptions,
  callbacks: AnswerCallbacks,
): Promise<void> {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    callbacks.onError?.("aborted");
    return;
  }
  const controller = new AbortController();
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    controller.abort();
    cancellation ??= options.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const context: TurnContext = {
    options,
    state: { text: "" },
    callbacks,
    signal: controller.signal,
  };
  const running: RunningTasks = { promptSettled: false };
  let outcome: TurnOutcome;
  try {
    outcome = await executeTurn(context, running);
  } catch (error) {
    outcome = controller.signal.aborted ? ABORTED : failure(error);
  } finally {
    // Settle only after remote cancellation and every request of this turn
    // finished, so a following reset or delete cannot race a live prompt.
    if (running.prompt !== undefined && !running.promptSettled) cancel();
    else controller.abort();
    await cancellation;
    await running.prompt;
    await running.stream;
    options.signal?.removeEventListener("abort", cancel);
  }
  switch (outcome.kind) {
    case "done":
      callbacks.onDone?.(outcome.text, Date.now() - startedAt, {
        reconciled: outcome.reconciled,
        sessionID: options.sessionID,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      });
      return;
    case "error":
      callbacks.onError?.(outcome.message);
      return;
  }
}
