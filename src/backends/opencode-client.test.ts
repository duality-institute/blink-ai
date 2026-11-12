import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { OpenCodeClient } from "./opencode-client";

const PromptSchema = z.object({
  model: z.object({ providerID: z.string(), modelID: z.string() }),
  tools: z.record(z.string(), z.boolean()),
  parts: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("file"),
        mime: z.literal("image/png"),
        filename: z.string(),
        url: z.string(),
      }),
      z.object({ type: z.literal("text"), text: z.string() }),
    ]),
  ),
});

type FakeOpenCode = {
  readonly url: string;
  readonly password: string;
  readonly promptBodies: unknown[];
  readonly requestUrls: string[];
  readonly authorizationHeaders: string[];
  readonly directoryHeaders: string[];
  readonly sessionIDs: string[];
  readonly deletedSessionIDs: string[];
  readonly eventSubscriptions: () => number;
  readonly waitForEventSubscriptions: (count: number) => Promise<void>;
  readonly abortRequests: () => number;
  readonly emit: (event: unknown) => void;
  readonly closeEvents: () => void;
  readonly waitForPrompt: () => Promise<void>;
  readonly completePrompt: () => void;
  readonly setMessages: (messages: unknown[]) => void;
  readonly stop: () => void;
};

function createFakeOpenCode(): FakeOpenCode {
  const encoder = new TextEncoder();
  const password = "test-password";
  const promptBodies: unknown[] = [];
  const requestUrls: string[] = [];
  const authorizationHeaders: string[] = [];
  const directoryHeaders: string[] = [];
  const sessionIDs: string[] = [];
  const deletedSessionIDs: string[] = [];
  const promptWaiters: Array<() => void> = [];
  const promptCompletions: Array<() => void> = [];
  const subscriptionWaiters: Array<{ count: number; resolve: () => void }> = [];
  let queuedPrompts = 0;
  let messages: unknown[] = [];
  let events = 0;
  let aborts = 0;
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frame = (event: unknown): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requestUrls.push(`${url.pathname}${url.search}`);
      const authorization = request.headers.get("authorization");
      if (authorization !== null) authorizationHeaders.push(authorization);
      const directory = request.headers.get("x-opencode-directory");
      if (directory !== null) directoryHeaders.push(directory);

      if (request.method === "GET" && url.pathname === "/event") {
        events += 1;
        for (const waiter of subscriptionWaiters.splice(0)) {
          if (events >= waiter.count) waiter.resolve();
          else subscriptionWaiters.push(waiter);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventController = controller;
              controller.enqueue(
                frame({ type: "server.connected", properties: {} }),
              );
            },
            cancel() {
              eventController = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const id = `session-${sessionIDs.length + 1}`;
        sessionIDs.push(id);
        return Response.json({ id, title: "Blink answer", version: "test" });
      }
      const deletion = /^\/session\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && deletion !== null) {
        deletedSessionIDs.push(deletion[1] ?? "");
        return Response.json(true);
      }
      if (request.method === "POST" && url.pathname.endsWith("/message")) {
        promptBodies.push(await request.json());
        const waiter = promptWaiters.shift();
        if (waiter === undefined) queuedPrompts += 1;
        else waiter();
        // Like OpenCode's synchronous prompt route, respond only once the
        // turn completes (or is aborted).
        await new Promise<void>((resolve) => {
          promptCompletions.push(resolve);
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return Response.json({ info: {}, parts: [] });
      }
      if (request.method === "GET" && url.pathname.endsWith("/message")) {
        return Response.json(messages);
      }
      if (request.method === "POST" && url.pathname.endsWith("/abort")) {
        aborts += 1;
        for (const complete of promptCompletions.splice(0)) complete();
        return Response.json(true);
      }
      if (request.method === "GET" && url.pathname === "/config/providers") {
        return Response.json({
          providers: [
            {
              id: "anthropic",
              models: {
                vision: { capabilities: { input: { image: true } } },
              },
            },
          ],
          default: {},
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: server.url.origin,
    password,
    promptBodies,
    requestUrls,
    authorizationHeaders,
    directoryHeaders,
    sessionIDs,
    deletedSessionIDs,
    eventSubscriptions: () => events,
    waitForEventSubscriptions(count) {
      if (events >= count) return Promise.resolve();
      return new Promise((resolve) => subscriptionWaiters.push({ count, resolve }));
    },
    abortRequests: () => aborts,
    emit(event) {
      eventController?.enqueue(frame(event));
    },
    closeEvents() {
      eventController?.close();
      eventController = undefined;
    },
    waitForPrompt() {
      if (queuedPrompts > 0) {
        queuedPrompts -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => promptWaiters.push(resolve));
    },
    completePrompt() {
      promptCompletions.shift()?.();
    },
    setMessages(next) {
      messages = next;
    },
    stop: () => server.stop(true),
  };
}

function createClient(fake: FakeOpenCode, projectDirectory: string): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: fake.url,
    password: fake.password,
    model: { providerID: "anthropic", modelID: "vision" },
    projectDirectory,
    prompts: {
      monitor: "Answer the screenshot.",
      meeting: "Use all supplied meeting context.",
    },
  });
}

const servers: FakeOpenCode[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCodeClient", () => {
  it.each(["monitor", "meeting"] as const)("keeps a %s user message separate from its instruction", async (kind) => {
    const fake = createFakeOpenCode();
    servers.push(fake);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-message-"));
    directories.push(directory);
    const client = createClient(fake, directory);
    const controller = new AbortController();
    const message = "Compare option A with B\nUse a table";
    const answer = client.answer({ kind, message, imagePaths: [] }, { signal: controller.signal });
    await fake.waitForPrompt();
    const prompt = PromptSchema.parse(fake.promptBodies[0]);
    controller.abort();
    await answer;
    expect(fake.abortRequests()).toBe(1);
    expect(prompt.parts).toHaveLength(2);
    expect(prompt.parts.at(-1)).toEqual({ type: "text", text: message });
    expect(prompt.parts.filter((part) => part.type === "file")).toHaveLength(0);
  });

  it("reuses its in-memory session and sends combined Meeting context", async () => {
    const fake = createFakeOpenCode();
    servers.push(fake);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-client-"));
    directories.push(directory);
    const firstImage = path.join(directory, "first.png");
    const secondImage = path.join(directory, "second.png");
    fs.writeFileSync(firstImage, new Uint8Array([1]));
    fs.writeFileSync(secondImage, new Uint8Array([2]));
    const client = createClient(fake, directory);
    const deltas: string[] = [];
    let completed = "";
    let usage: unknown;

    const answer = client.answer(
      {
        kind: "meeting",
        text: "Them: What should we ship?",
        imagePaths: [firstImage, secondImage],
      },
      {
        onDelta: (delta) => deltas.push(delta),
        onDone: (text, _duration, metadata) => {
          completed = text;
          usage = metadata.usage;
        },
      },
    );
    await fake.waitForPrompt();
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "Ship Blink.",
      },
    });
    fake.emit({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "message-1",
          role: "assistant",
          time: { created: 1 },
          cost: 0.0042,
          tokens: { input: 300, output: 12, reasoning: 0, cache: { read: 40, write: 0 } },
        },
      },
    });
    fake.emit({
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    });
    fake.completePrompt();
    await answer;

    expect(usage).toEqual({
      input: 300,
      output: 12,
      reasoning: 0,
      cacheRead: 40,
      cacheWrite: 0,
      cost: 0.0042,
    });
    const prompt = PromptSchema.parse(fake.promptBodies[0]);
    expect(prompt.parts.filter((part) => part.type === "file")).toHaveLength(2);
    expect(prompt.parts.at(-1)).toEqual({
      type: "text",
      text: "Use all supplied meeting context.\n\nMeeting transcript:\nThem: What should we ship?",
    });
    expect(Object.values(prompt.tools).some(Boolean)).toBe(false);
    expect(deltas).toEqual(["Ship Blink."]);
    expect(completed).toBe("Ship Blink.");
    expect(fake.sessionIDs).toEqual(["session-1"]);
    expect(fake.requestUrls[0]).toContain(`directory=${encodeURIComponent(directory)}`);
    expect(
      fake.requestUrls.filter((requestUrl) => requestUrl.startsWith("/event")),
    ).toEqual([`/event?directory=${encodeURIComponent(directory)}`]);
    expect(fake.directoryHeaders).toContain(encodeURIComponent(directory));
    expect(fake.authorizationHeaders).toContain(
      `Basic ${Buffer.from(`opencode:${fake.password}`).toString("base64")}`,
    );

    expect(await client.resetSession()).toBe("session-2");
    expect(fake.deletedSessionIDs).toEqual(["session-1"]);
    expect(await client.checkVisionCapability()).toEqual({ ok: true });

    await client.discardSession();
    await client.discardSession();
    expect(fake.deletedSessionIDs).toEqual(["session-1", "session-2"]);
  });

  it("reconciles once when the primary event stream ends early", async () => {
    const fake = createFakeOpenCode();
    servers.push(fake);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-client-"));
    directories.push(directory);
    const client = createClient(fake, directory);
    let result: { text: string; reconciled: boolean; usage: unknown } | undefined;

    const answer = client.answer(
      { kind: "meeting", text: "context", imagePaths: [] },
      {
        onDone: (text, _duration, metadata) => {
          result = { text, reconciled: metadata.reconciled, usage: metadata.usage };
        },
      },
    );
    await fake.waitForPrompt();
    fake.closeEvents();
    await fake.waitForEventSubscriptions(2);
    fake.setMessages([
      userMessage("message-1"),
      assistantMessage({
        id: "message-2",
        completed: true,
        text: "Complete reconciled answer.",
        tokens: { input: 50, output: 9, reasoning: 3, cache: { read: 0, write: 0 } },
      }),
    ]);
    fake.completePrompt();
    await answer;

    expect(result).toEqual({
      text: "Complete reconciled answer.",
      reconciled: true,
      usage: { input: 50, output: 9, reasoning: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    });
    expect(fake.eventSubscriptions()).toBe(2);
    expect(fake.requestUrls).toContain("/session/session-1/message?directory=" + encodeURIComponent(directory));
  });

  it.each([
    { current: undefined, case: "no current-turn assistant" },
    { current: { completed: false, error: false }, case: "an unfinished current-turn answer" },
    { current: { completed: true, error: true }, case: "a failed current-turn answer" },
  ])("never reconciles an earlier answer or $case into success", async ({ current }) => {
    const fake = createFakeOpenCode();
    servers.push(fake);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-client-"));
    directories.push(directory);
    const previousTurn = [
      userMessage("message-1"),
      assistantMessage({ id: "message-2", completed: true, text: "Previous answer." }),
    ];
    fake.setMessages(previousTurn);
    const client = createClient(fake, directory);
    const completions: string[] = [];
    const errors: string[] = [];

    const answer = client.answer(
      { kind: "meeting", text: "new context", imagePaths: [] },
      { onDone: (text) => completions.push(text), onError: (message) => errors.push(message) },
    );
    await fake.waitForPrompt();
    fake.setMessages([
      ...previousTurn,
      userMessage("message-3"),
      ...(current === undefined
        ? []
        : [assistantMessage({ id: "message-4", text: "Partial answ", ...current })]),
    ]);
    fake.emit({
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    });
    fake.completePrompt();
    await answer;

    expect(completions).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("streams deltas while the synchronous prompt is still running", async () => {
    const fake = createFakeOpenCode();
    servers.push(fake);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-client-"));
    directories.push(directory);
    const client = createClient(fake, directory);
    let firstDelta: () => void = () => undefined;
    const deltaSeen = new Promise<void>((resolve) => {
      firstDelta = resolve;
    });
    let completed = "";

    const answer = client.answer(
      { kind: "monitor", imagePaths: [] },
      { onDelta: () => firstDelta(), onDone: (text) => { completed = text; } },
    );
    await fake.waitForPrompt();
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-2",
        partID: "part-1",
        field: "text",
        delta: "Live.",
      },
    });
    await deltaSeen;
    expect(completed).toBe("");
    fake.emit({
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    });
    fake.completePrompt();
    await answer;

    expect(completed).toBe("Live.");
  });
});

function userMessage(id: string): unknown {
  return {
    info: { id, sessionID: "session-1", role: "user", time: { created: 1 } },
    parts: [{ type: "text", text: "question" }],
  };
}

function assistantMessage(message: {
  readonly id: string;
  readonly text: string;
  readonly completed: boolean;
  readonly error?: boolean;
  readonly tokens?: unknown;
}): unknown {
  return {
    info: {
      id: message.id,
      sessionID: "session-1",
      role: "assistant",
      time: message.completed ? { created: 1, completed: 2 } : { created: 1 },
      ...(message.error === true
        ? { error: { name: "MessageOutputLengthError", data: {} } }
        : {}),
      cost: 0.01,
      tokens: message.tokens ?? { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "text", text: message.text }],
  };
}
