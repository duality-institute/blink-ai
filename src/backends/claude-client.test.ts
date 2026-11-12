import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeClient } from "./claude-client";
import type { JsonlProcessOptions } from "./process-runner";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const SECOND_PNG = Buffer.from("89504e470d0a1a0b", "hex");

type SentMessage = {
  type: string;
  message: { role: string; content: unknown[] };
};

function imageBlock(bytes: Buffer): unknown {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
  };
}

describe("ClaudeClient", () => {
  let home: string;
  let shot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-claude-"));
    shot = path.join(home, "shot.png");
    fs.writeFileSync(shot, PNG);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function client(
    runner: (options: JsonlProcessOptions) => Promise<void>,
    model?: string,
  ): ClaudeClient {
    return new ClaudeClient({
      prompts: { monitor: "Answer it", meeting: "Help the meeting" },
      projectDir: home,
      model,
      command: process.execPath,
      runner,
    });
  }

  function succeeding(calls: JsonlProcessOptions[], sessionId = "s1") {
    return async (options: JsonlProcessOptions): Promise<void> => {
      calls.push(options);
      await options.onJson({ type: "system", subtype: "init", session_id: sessionId });
      await options.onJson({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "Partial" } },
      });
      await options.onJson({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: "Partial answer",
      });
    };
  }

  it("sends a raw base64 image block, streams deltas, then resumes", async () => {
    const calls: JsonlProcessOptions[] = [];
    const claude = client(succeeding(calls));

    const deltas: string[] = [];
    const answers: string[] = [];
    await claude.answer({ kind: "monitor", imagePaths: [shot] }, {
      onDelta: (text) => deltas.push(text),
      onDone: (text) => answers.push(text),
    });
    await claude.answer({ kind: "monitor", imagePaths: [shot] }, {
      onDone: (text) => answers.push(text),
    });

    expect(deltas).toEqual(["Partial"]);
    expect(answers).toEqual(["Partial answer", "Partial answer"]);

    const sent = JSON.parse(calls[0]?.input ?? "") as SentMessage;
    expect(sent.type).toBe("user");
    expect(sent.message.content).toEqual([
      imageBlock(PNG),
      { type: "text", text: "Answer it" },
    ]);

    expect(calls[0]?.args).not.toContain("Read");
    expect(calls[0]?.args).not.toContain("--model");
    expect(calls[1]?.args).toContain("--resume");
    expect(calls[1]?.args).toContain("s1");
  });

  it("batches every image with the transcript and a separate typed message", async () => {
    const second = path.join(home, "second.png");
    fs.writeFileSync(second, SECOND_PNG);
    const calls: JsonlProcessOptions[] = [];
    const claude = client(succeeding(calls, "meeting-1"), "opus");

    for (let turn = 0; turn < 2; turn += 1) {
      await claude.answer({
        kind: "meeting",
        imagePaths: [shot, second],
        text: "Them: Which index fits?",
        message: "Keep it short",
        prompt: "Custom instruction",
      }, {});
    }

    const sent = JSON.parse(calls[1]?.input ?? "") as SentMessage;
    expect(sent.message.content).toEqual([
      imageBlock(PNG),
      imageBlock(SECOND_PNG),
      { type: "text", text: "Custom instruction\n\nMeeting transcript:\nThem: Which index fits?" },
      { type: "text", text: "Keep it short" },
    ]);
    const resumed = calls[1]?.args ?? [];
    expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2))
      .toEqual(["--resume", "meeting-1"]);
    expect(resumed.slice(resumed.indexOf("--model"), resumed.indexOf("--model") + 2))
      .toEqual(["--model", "opus"]);
  });

  it("surfaces result errors without completing", async () => {
    const claude = client(async (options) => {
      await options.onJson({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "rate limited",
      });
    });

    const errors: string[] = [];
    const answers: string[] = [];
    await claude.answer({ kind: "monitor", imagePaths: [shot] }, {
      onDone: (text) => answers.push(text),
      onError: (message) => errors.push(message),
    });

    expect(errors).toEqual(["rate limited"]);
    expect(answers).toEqual([]);
  });

  it("sends transcript questions without an image content block", async () => {
    const calls: JsonlProcessOptions[] = [];
    const claude = client(async (options) => {
      calls.push(options);
      await options.onJson({
        type: "system",
        subtype: "init",
        session_id: "text-session",
      });
      await options.onJson({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "text-session",
        result: "Use a bounded queue.",
      });
    });
    const question = "Them: How should this be designed?";
    const answers: string[] = [];

    await claude.answer({ kind: "meeting", imagePaths: [], text: question }, {
      onDone: (text) => answers.push(text),
    });

    const sent = JSON.parse(calls[0]?.input ?? "") as SentMessage;
    expect(sent.message.content).toEqual([
      { type: "text", text: `Help the meeting\n\nMeeting transcript:\n${question}` },
    ]);
    expect(answers).toEqual(["Use a bounded queue."]);
  });

  it("starts a new session only after an explicit reset", async () => {
    const calls: JsonlProcessOptions[] = [];
    const claude = client(succeeding(calls));

    await claude.answer({ kind: "monitor", imagePaths: [shot] }, {});
    await claude.resetSession();
    await claude.answer({ kind: "monitor", imagePaths: [shot] }, {});

    expect(calls[1]?.args).not.toContain("--resume");
  });
});
