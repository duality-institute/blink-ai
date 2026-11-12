import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerCallbacks } from "../core/answer-client";
import { LocalAnswerClient } from "./local-answer-client";
import type { LocalAnswerInput, LocalEngine } from "./local-engine";

for (const mode of ["monitor", "meeting"] as const) {
  for (const input of ["text", "images", "both"] as const) {
    it(`sends ${input} through the ${mode} client to the local engine`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "blink-user-message-"));
      const screenshot = join(directory, "capture.png");
      await writeFile(screenshot, new Uint8Array([1, 2, 3]));
      const message = input === "images" ? "" : "Explain the tradeoffs\n请简短回答";
      const paths = input === "text" ? [] : [screenshot];
      const received: LocalAnswerInput[] = [];
      const images: number[][] = [];
      const engine = (): LocalEngine => ({
        async answer(request: LocalAnswerInput, callbacks: AnswerCallbacks) {
          received.push(request);
          for (const file of request.imagePaths) images.push([...await readFile(file)]);
          callbacks.onDone?.("response", 1, { sessionID: "session", reconciled: false });
        },
        async resetSession() { return "session"; },
        async discardSession() {},
        async checkVisionCapability() { return { ok: true }; },
      });
      const client = new LocalAnswerClient({
        label: "Local",
        engines: { monitor: engine(), meeting: engine() },
        prompts: { monitor: "monitor-default", meeting: "meeting-default" },
      });
      client.setPrompts({
        monitor: mode === "monitor" ? "custom-instruction" : "",
        meeting: mode === "meeting" ? "custom-instruction" : "",
      });
      try {
        const errors: string[] = [];
        const replies: string[] = [];
        const callbacks = {
          onError: (error: string) => { errors.push(error); },
          onDone: (text: string) => { replies.push(text); },
        };
        await client.resetSession(mode);
        if (mode === "monitor") await client.answerMonitor(paths, callbacks, message);
        else await client.answerMeeting({ screenshotPaths: paths, message }, callbacks);

        expect(errors).toEqual([]);
        expect(replies).toEqual(["response"]);
        expect(received).toHaveLength(1);
        expect(received[0]?.message).toBe(message || undefined);
        expect(received[0]?.prompt).toBe("custom-instruction");
        expect(images).toEqual(input === "text" ? [] : [[1, 2, 3]]);
      } finally {
        await client.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
