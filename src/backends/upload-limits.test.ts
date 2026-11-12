import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerCallbacks } from "../core/answer-client";
import { MAX_ASK_BODY_BYTES, STAGING_OVERHEAD_BYTES } from "../core/upload-limits";
import { LocalAnswerClient } from "./local-answer-client";
import type { LocalAnswerInput, LocalEngine } from "./local-engine";

describe("local ask admission", () => {
  let directory: string;
  let dispatched: LocalAnswerInput[];
  let client: LocalAnswerClient;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "blink-upload-"));
  });
  beforeEach(() => {
    dispatched = [];
    const engine = (): LocalEngine => ({
      async answer(input: LocalAnswerInput, callbacks: AnswerCallbacks) {
        dispatched.push(input);
        callbacks.onDone?.("ok", 1, { sessionID: "test", reconciled: false });
      },
      async resetSession() { return "test"; },
      async discardSession() {},
      async checkVisionCapability() { return { ok: true }; },
    });
    client = new LocalAnswerClient({
      label: "Local",
      engines: { monitor: engine(), meeting: engine() },
      prompts: { monitor: "monitor prompt", meeting: "meeting prompt" },
    });
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  function failures(): { readonly errors: string[]; readonly callbacks: AnswerCallbacks } {
    const errors: string[] = [];
    return { errors, callbacks: { onError: (error) => { errors.push(error); } } };
  }

  it.each([
    [11, 1, "10 screenshots"],
    [1, 8 * 1024 * 1024 + 1, "8 MiB"],
    [4, 6 * 1024 * 1024, "20 MiB"],
  ])("rejects %i files of %i bytes before any engine call", async (count, bytes, message) => {
    const file = join(directory, "capture.png");
    await writeFile(file, new Uint8Array(bytes));
    const { errors, callbacks } = failures();
    await client.answerMonitor(Array.from({ length: count }, () => file), callbacks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
    expect(dispatched).toEqual([]);
  });

  it("counts transcript bytes and staging overhead before dispatch", async () => {
    const { errors, callbacks } = failures();
    const transcript = "x".repeat(MAX_ASK_BODY_BYTES - STAGING_OVERHEAD_BYTES / 2);
    await client.answerMeeting({ transcript, screenshotPaths: [] }, callbacks);
    expect(errors[0]).toContain("20 MiB");
    expect(dispatched).toEqual([]);
  });

  it("counts transcript context in UTF-8 bytes, not characters", async () => {
    const { errors, callbacks } = failures();
    await client.answerMeeting({ transcript: "é".repeat(11 * 1024 * 1024), screenshotPaths: [] }, callbacks);
    expect(errors[0]).toContain("20 MiB");
    expect(dispatched).toEqual([]);
  });

  it("counts the configured instruction toward the context limit", async () => {
    client.setPrompts({ monitor: "x".repeat(20 * 1024 * 1024), meeting: "" });
    const { errors, callbacks } = failures();
    await client.answerMonitor([], callbacks, "What is this?");
    expect(errors[0]).toContain("20 MiB");
    expect(dispatched).toEqual([]);
  });

  it("rejects a blank Monitor Ask with no screenshots", async () => {
    const { errors, callbacks } = failures();
    await client.answerMonitor([], callbacks, " \n\t ");
    expect(errors).toEqual(["Requests need a message, transcript, or screenshot"]);
    expect(dispatched).toEqual([]);
  });

  it("rejects a Meeting Ask with only a blank transcript", async () => {
    const { errors, callbacks } = failures();
    await client.answerMeeting({ screenshotPaths: [], transcript: " \r\n " }, callbacks);
    expect(errors).toEqual(["Requests need a message, transcript, or screenshot"]);
    expect(dispatched).toEqual([]);
  });

  it("rejects a typed message longer than the composer limit", async () => {
    const { errors, callbacks } = failures();
    await client.answerMonitor([], callbacks, "x".repeat(16_001));
    expect(errors).toEqual(["Message exceeds 16000 characters."]);
    expect(dispatched).toEqual([]);
  });

  it("measures the message limit after CRLF normalization", async () => {
    await client.answerMeeting({ screenshotPaths: [], message: "a\r\nb".repeat(4_001) }, {});
    expect(dispatched.map((input) => input.message)).toEqual(["a\nb".repeat(4_001)]);
  });

  it("dispatches valid asks and remains usable after rejection", async () => {
    const file = join(directory, "valid.png");
    await writeFile(file, new Uint8Array(1024));
    await client.answerMonitor(Array.from({ length: 11 }, () => file), {});
    let answer = "";
    await client.answerMonitor([file], { onDone: (text) => { answer = text; } });
    expect(answer).toBe("ok");
    expect(dispatched.map((input) => input.imagePaths)).toEqual([[file]]);
  });
});
