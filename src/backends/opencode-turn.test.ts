import { expect, it } from "bun:test";
import { runOpenCodeTurn } from "./opencode-turn";

it.each([
  { delta: "answer", saved: "", expected: "answer" },
  { delta: "", saved: "saved answer", expected: "saved answer" },
  { delta: "", saved: "", expected: undefined },
])("handles empty stream text with delta=$delta and saved=$saved", async ({ delta, saved, expected }) => {
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const emit = (event: unknown): void => stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        emit({ type: "server.connected", properties: {} });
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const deltas: string[] = [];
  const completions: string[] = [];
  const errors: string[] = [];
  try {
    await runOpenCodeTurn({
      baseUrl: server.url.origin,
      password: "test-password",
      directory: "/test",
      sessionID: "session-1",
      async sendPrompt() {
        for (const text of ["", delta]) emit({ type: "message.part.delta", properties: {
          sessionID: "session-1", messageID: "message-1", partID: "part-1", field: "text", delta: text,
        } });
        emit({ type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } });
      },
      async reconcile() { return { text: saved }; },
      async abort() {},
    }, {
      onDelta: (text) => deltas.push(text),
      onDone: (text) => completions.push(text),
      onError: (message) => errors.push(message),
    });

    expect(deltas).toEqual(delta === "" ? [] : [delta]);
    expect(completions).toEqual(expected === undefined ? [] : [expected]);
    expect(errors).toHaveLength(expected === undefined ? 1 : 0);
    if (expected === undefined) expect(errors[0]?.length).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

it("settles an aborted turn only after remote cancellation and the prompt finish", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        ));
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const log: string[] = [];
  const user = new AbortController();
  const afterMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  try {
    await runOpenCodeTurn({
      baseUrl: server.url.origin,
      password: "test-password",
      directory: "/test",
      sessionID: "session-1",
      signal: user.signal,
      sendPrompt: (signal) => {
        queueMicrotask(() => user.abort());
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            void afterMacrotask().then(() => {
              log.push("prompt settled");
              reject(new DOMException("aborted", "AbortError"));
            });
          }, { once: true });
        });
      },
      async reconcile() { return { text: "unused" }; },
      async abort() {
        await afterMacrotask();
        await afterMacrotask();
        log.push("remote abort settled");
      },
    }, {
      onDone: () => log.push("done"),
      onError: (message) => log.push(`error:${message}`),
    });
    log.push("turn settled");

    expect(log.slice(-2)).toEqual(["error:aborted", "turn settled"]);
    expect(log.slice(0, -2).toSorted()).toEqual(["prompt settled", "remote abort settled"]);
  } finally {
    server.stop(true);
  }
});
