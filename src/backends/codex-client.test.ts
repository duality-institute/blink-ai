import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexClient } from "./codex-client";
import { ProcessAbortedError, type JsonlProcessOptions } from "./process-runner";

describe("CodexClient", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-codex-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function client(
    runner: (options: JsonlProcessOptions) => Promise<void>,
    model?: string,
  ): CodexClient {
    return new CodexClient({
      prompts: { monitor: "Answer it", meeting: "Help the meeting" },
      projectDir: home,
      model,
      command: process.execPath,
      runner,
    });
  }

  function threaded(calls: JsonlProcessOptions[], threadId = "thread-1") {
    return async (options: JsonlProcessOptions): Promise<void> => {
      calls.push(options);
      await options.onJson({ type: "thread.started", thread_id: threadId });
      await options.onJson({
        type: "item.completed",
        item: { type: "agent_message", text: "Hi" },
      });
    };
  }

  it("streams deltas, then resumes the in-memory thread", async () => {
    const calls: JsonlProcessOptions[] = [];
    const codex = client(async (options) => {
      calls.push(options);
      await options.onJson({ type: "thread.started", thread_id: "thread-1" });
      await options.onJson({
        type: "item.updated",
        item: { type: "agent_message", text: "Hel" },
      });
      await options.onJson({
        type: "item.completed",
        item: { type: "agent_message", text: "Hello" },
      });
    });

    const deltas: string[] = [];
    const answers: string[] = [];
    await codex.answer({ kind: "monitor", imagePaths: ["/tmp/one.png"] }, {
      onDelta: (text) => deltas.push(text),
      onDone: (text) => answers.push(text),
    });
    await codex.answer({ kind: "monitor", imagePaths: ["/tmp/two.png"] }, {
      onDone: (text) => answers.push(text),
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(answers).toEqual(["Hello", "Hello"]);
    expect(calls[0]?.args).not.toContain("--ask-for-approval");
    expect(calls[0]?.args).not.toContain("resume");
    expect(calls[0]?.args).not.toContain("--model");

    const resumed = calls[1]?.args ?? [];
    expect(resumed).toContain("thread-1");
    expect(resumed.indexOf("resume")).toBeLessThan(resumed.indexOf("--image"));
  });

  it("keeps resuming the same thread past ten turns", async () => {
    const calls: JsonlProcessOptions[] = [];
    const codex = client(threaded(calls));

    for (let turn = 0; turn < 12; turn += 1) {
      await codex.answer({ kind: "monitor", imagePaths: [`/tmp/${turn}.png`] }, {});
    }

    expect(calls.slice(1).every((call) => call.args.includes("thread-1"))).toBe(true);
  });

  it("attaches every image and separates transcript and message on stdin", async () => {
    const calls: JsonlProcessOptions[] = [];
    const codex = client(threaded(calls, "meeting-thread"), "gpt-5");

    for (let turn = 0; turn < 2; turn += 1) {
      await codex.answer({
        kind: "meeting",
        imagePaths: ["/tmp/one.png", "/tmp/two.png"],
        text: "Them: Which index fits?",
        message: "Keep it short",
        prompt: "Custom instruction",
      }, {});
    }

    expect(calls[1]?.input).toBe(
      "Custom instruction\n\nMeeting transcript:\nThem: Which index fits?\n\nUser message:\nKeep it short",
    );
    const args = calls[1]?.args ?? [];
    expect(args.slice(args.indexOf("resume"))).toEqual([
      "resume",
      "--image",
      "/tmp/one.png",
      "--image",
      "/tmp/two.png",
      "--",
      "meeting-thread",
      "-",
    ]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2))
      .toEqual(["--model", "gpt-5"]);
  });

  it("sends transcript questions on stdin without an image argument", async () => {
    const calls: JsonlProcessOptions[] = [];
    const codex = client(async (options) => {
      calls.push(options);
      await options.onJson({ type: "thread.started", thread_id: "thread-text" });
      await options.onJson({
        type: "item.completed",
        item: { type: "agent_message", text: "Use a bounded queue." },
      });
    });
    const answers: string[] = [];
    const question = "Them: How should this be designed?";

    await codex.answer({ kind: "meeting", imagePaths: [], text: question }, {
      onDone: (text) => answers.push(text),
    });

    expect(calls[0]?.input).toBe(`Help the meeting\n\nMeeting transcript:\n${question}`);
    expect(calls[0]?.args).not.toContain("--image");
    expect(answers).toEqual(["Use a bounded queue."]);
  });

  it("maps the caller signal to the active process", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const codex = client(async (options) => {
      started?.();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new ProcessAbortedError();
    });

    const controller = new AbortController();
    const errors: string[] = [];
    const answering = codex.answer({ kind: "monitor", imagePaths: ["/tmp/one.png"] }, {
      onError: (message) => errors.push(message),
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    await answering;

    expect(errors).toEqual(["aborted"]);
  });
});
