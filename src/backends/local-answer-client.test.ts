import { describe, expect, it } from "bun:test";
import type { AnswerCallbacks } from "../core/answer-client";
import { DEFAULT_MONITOR_PROMPT } from "../core/prompts";
import { LocalAnswerClient } from "./local-answer-client";
import type { LocalAnswerInput, LocalEngine } from "./local-engine";

type Answerer = (input: LocalAnswerInput, callbacks: AnswerCallbacks) => Promise<void>;

const ASK = "What does this show?";

class FakeEngine implements LocalEngine {
  readonly inputs: LocalAnswerInput[] = [];
  readonly events: string[] = [];
  readonly started: Promise<void>;
  private readonly answerer: Answerer;
  private markStarted: () => void = () => undefined;

  constructor(answerer: Answerer = async (_input, callbacks) => {
    callbacks.onDone?.("answer", 1, { reconciled: false, sessionID: "fake" });
  }) {
    this.answerer = answerer;
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  answer(input: LocalAnswerInput, callbacks: AnswerCallbacks): Promise<void> {
    this.inputs.push(input);
    this.markStarted();
    return this.answerer(input, callbacks);
  }

  resetSession(): Promise<string> {
    this.events.push("reset");
    return Promise.resolve("fresh");
  }

  discardSession(): Promise<void> {
    this.events.push("discard");
    return Promise.resolve();
  }

  checkVisionCapability() {
    return Promise.resolve({ ok: true } as const);
  }
}

function waitForAbort(events: string[]): Answerer {
  return async (_input, callbacks) => {
    await new Promise<void>((resolve) => {
      callbacks.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("engine stopped");
    callbacks.onError?.("aborted");
  };
}

function setup(monitor = new FakeEngine(), meeting = new FakeEngine()) {
  const released: string[] = [];
  const client = new LocalAnswerClient({
    label: "Fake",
    engines: { monitor, meeting },
    prompts: { monitor: "monitor prompt", meeting: "meeting prompt" },
    release: async () => {
      released.push("release");
    },
  });
  return { client, monitor, meeting, released };
}

function recorder() {
  const terminals: string[] = [];
  const callbacks: AnswerCallbacks = {
    onDone: (text) => terminals.push(`done:${text}`),
    onError: (message) => terminals.push(`error:${message}`),
  };
  return { terminals, callbacks };
}

describe("LocalAnswerClient", () => {
  it("routes each mode to its own engine and resets only that mode", async () => {
    const { client, monitor, meeting } = setup();

    await client.answerMonitor([], {}, "typed");
    await client.answerMeeting({ screenshotPaths: [], transcript: "Them: hi" }, {});
    await client.resetSession("meeting");
    await client.endSession("monitor");

    expect(monitor.inputs.map((input) => input.kind)).toEqual(["monitor"]);
    expect(meeting.inputs.map((input) => input.kind)).toEqual(["meeting"]);
    expect(monitor.events).toEqual(["discard"]);
    expect(meeting.events).toEqual(["reset"]);
  });

  it("abort signals the engine and resolves only after it stopped", async () => {
    const events: string[] = [];
    const monitor = new FakeEngine(waitForAbort(events));
    const { client } = setup(monitor);
    const { terminals, callbacks } = recorder();

    const answering = client.answerMonitor([], callbacks, ASK);
    await monitor.started;
    await client.abort();
    events.push("abort resolved");
    await answering;

    expect(events).toEqual(["engine stopped", "abort resolved"]);
    expect(terminals).toEqual(["error:aborted"]);
  });

  it("drains the active answer before resetting the session", async () => {
    const events: string[] = [];
    const monitor = new FakeEngine(waitForAbort(events));
    const { client } = setup(monitor);

    const answering = client.answerMonitor([], {}, ASK);
    await monitor.started;
    await client.resetSession("monitor");
    await answering;

    expect([...events, ...monitor.events]).toEqual(["engine stopped", "reset"]);
  });

  it("forwards the caller's abort signal to the engine", async () => {
    const events: string[] = [];
    const { client, monitor } = setup(new FakeEngine(waitForAbort(events)));
    const controller = new AbortController();
    const { terminals, callbacks } = recorder();

    const answering = client.answerMonitor([], { ...callbacks, signal: controller.signal }, ASK);
    await monitor.started;
    controller.abort();
    await answering;

    expect(events).toEqual(["engine stopped"]);
    expect(terminals).toEqual(["error:aborted"]);
  });

  it("never dispatches an Ask aborted while it is being admitted", async () => {
    const { client, monitor } = setup();
    const { terminals, callbacks } = recorder();

    const answering = client.answerMonitor([], callbacks, ASK);
    await client.abort();
    await answering;

    expect(monitor.inputs).toEqual([]);
    expect(terminals).toEqual(["error:aborted"]);
  });

  it("reports an engine that throws before any callback exactly once", async () => {
    const { client } = setup(new FakeEngine(() => Promise.reject(new Error("spawn failed"))));
    const { terminals, callbacks } = recorder();

    await client.answerMonitor([], callbacks, ASK);

    expect(terminals).toEqual(["error:spawn failed"]);
  });

  it("delivers one terminal callback even when the engine misbehaves", async () => {
    const twice = new FakeEngine(async (_input, callbacks) => {
      callbacks.onDone?.("first", 1, { reconciled: false, sessionID: "s" });
      callbacks.onDone?.("second", 1, { reconciled: false, sessionID: "s" });
      callbacks.onError?.("late");
    });
    const silent = new FakeEngine(async () => undefined);
    const { client } = setup(twice, silent);
    const { terminals, callbacks } = recorder();

    await client.answerMonitor([], callbacks, ASK);
    await client.answerMeeting({ screenshotPaths: [], message: ASK }, callbacks);

    expect(terminals).toEqual(["done:first", "error:Fake completed without an answer"]);
  });

  it("rejects a second Ask while one is running", async () => {
    const events: string[] = [];
    const { client } = setup(new FakeEngine(waitForAbort(events)));
    const { terminals, callbacks } = recorder();

    const first = client.answerMonitor([], {}, ASK);
    await client.answerMeeting({ screenshotPaths: [], message: ASK }, callbacks);
    await client.abort();
    await first;

    expect(terminals).toEqual(["error:Fake is already processing an answer"]);
  });

  it("applies new prompts to the next Ask without touching sessions", async () => {
    const { client, monitor, meeting } = setup();

    await client.answerMonitor([], {}, ASK);
    client.setPrompts({ monitor: "  ", meeting: "new meeting prompt" });
    await client.answerMonitor([], {}, ASK);
    await client.answerMeeting({ screenshotPaths: [], message: ASK }, {});

    expect(monitor.inputs.map((input) => input.prompt)).toEqual([
      "monitor prompt",
      DEFAULT_MONITOR_PROMPT,
    ]);
    expect(meeting.inputs[0]?.prompt).toBe("new meeting prompt");
    expect([...monitor.events, ...meeting.events]).toEqual([]);
  });

  it("disposes once, ending both sessions before releasing the server", async () => {
    const events: string[] = [];
    const { client, monitor, meeting, released } = setup(new FakeEngine(waitForAbort(events)));
    const { terminals, callbacks } = recorder();

    const answering = client.answerMonitor([], {}, ASK);
    await monitor.started;
    await Promise.all([client.dispose(), client.dispose()]);
    await client.dispose();
    await answering;
    await client.answerMonitor([], callbacks, ASK);

    expect(events).toEqual(["engine stopped"]);
    expect(monitor.events).toEqual(["discard"]);
    expect(meeting.events).toEqual(["discard"]);
    expect(released).toEqual(["release"]);
    expect(terminals).toEqual(["error:Fake client is disposed"]);
    const reset = await client.resetSession("monitor").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(reset).toBe("Fake client is disposed");
  });
});
