import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeClient } from "./claude-client";
import { CodexClient } from "./codex-client";
import { LocalAnswerClient } from "./local-answer-client";
import type { LocalEngine } from "./local-engine";
import type { JsonlProcessOptions } from "./process-runner";

const PROMPTS = { monitor: "monitor-default", meeting: "meeting-default" };

type Runner = (options: JsonlProcessOptions) => Promise<void>;

type Backend = {
  readonly name: string;
  readonly create: (projectDir: string, runner: Runner) => LocalEngine;
  readonly complete: Runner;
  /** The instruction and image bytes the CLI received, in order. */
  readonly sent: (call: JsonlProcessOptions) => Promise<readonly string[]>;
};

type ClaudeBlock = { readonly text?: string; readonly source?: { readonly data: string } };

const BACKENDS: readonly Backend[] = [
  {
    name: "claude",
    create: (projectDir, runner) => new ClaudeClient({ prompts: PROMPTS, projectDir, runner }),
    complete: async (options) => {
      await options.onJson({ type: "result", subtype: "success", is_error: false, result: "answer" });
    },
    sent: async (call) => {
      const sent = JSON.parse(call.input ?? "") as { message: { content: ClaudeBlock[] } };
      return sent.message.content.map((block) =>
        block.text ?? Buffer.from(block.source?.data ?? "", "base64").toString("hex"));
    },
  },
  {
    name: "codex",
    create: (projectDir, runner) => new CodexClient({ prompts: PROMPTS, projectDir, runner }),
    complete: async (options) => {
      await options.onJson({ type: "item.completed", item: { type: "agent_message", text: "answer" } });
    },
    sent: async (call) => {
      const images = call.args.filter((_arg, index) => call.args[index - 1] === "--image");
      const bytes = await Promise.all(images.map((file) => Bun.file(file).bytes()));
      return [...bytes.map((data) => Buffer.from(data).toString("hex")), call.input ?? ""];
    },
  },
];

for (const backend of BACKENDS) {
  it.each(["", " \n\t "])(`completes screenshot-only ${backend.name} Meeting asks with blank transcript %j`, async (transcript) => {
    const directory = await mkdtemp(join(tmpdir(), "blink-screenshot-only-"));
    const screenshotPaths = [join(directory, "first.png"), join(directory, "second.png")];
    const calls: JsonlProcessOptions[] = [];
    const sent: (readonly string[])[] = [];
    const runner: Runner = async (options) => {
      calls.push(options);
      sent.push(await backend.sent(options));
      await backend.complete(options);
    };
    const engine = (): LocalEngine => backend.create(directory, runner);
    const client = new LocalAnswerClient({
      label: backend.name,
      engines: { monitor: engine(), meeting: engine() },
      prompts: PROMPTS,
    });
    try {
      await Promise.all(screenshotPaths.map((file, index) => writeFile(file, new Uint8Array([index + 1]))));
      const errors: string[] = [];
      const completions: string[] = [];

      await client.answerMeeting({ transcript, screenshotPaths }, {
        onError: (message) => errors.push(message),
        onDone: (text) => completions.push(text),
      });

      expect(errors).toEqual([]);
      expect(completions).toEqual(["answer"]);
      expect(calls).toHaveLength(1);
      expect(sent).toEqual([["01", "02", "meeting-default"]]);
    } finally {
      await client.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
