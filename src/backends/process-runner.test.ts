import { describe, expect, it } from "bun:test";
import { ProcessAbortedError, runJsonlProcess } from "./process-runner";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("expected a rejection");
  } catch (error) {
    return error as Error;
  }
}

describe("runJsonlProcess", () => {
  it("parses newline-delimited JSON", async () => {
    const values: unknown[] = [];
    await runJsonlProcess({
      command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({type:"one"}))'],
      onJson: (value) => {
        values.push(value);
      },
    });
    expect(values).toEqual([{ type: "one" }]);
  });

  it("surfaces stderr from a non-zero exit", async () => {
    const error = await rejection(
      runJsonlProcess({
        command: process.execPath,
        args: ["-e", 'console.error("provider failed"); process.exit(7);'],
        onJson: () => undefined,
      }),
    );
    expect(error.message).toMatch(/code 7.*provider failed/);
  });

  it("aborts a running process", async () => {
    const controller = new AbortController();
    const running = runJsonlProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
      onJson: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    expect(await rejection(running)).toBeInstanceOf(ProcessAbortedError);
  });

  it("rejects promptly when the command is missing", async () => {
    const error = await rejection(
      runJsonlProcess({
        command: "/definitely/missing/blink-command",
        args: [],
        onJson: () => undefined,
      }),
    );
    expect(error.message).toMatch(/ENOENT/);
  });
});
