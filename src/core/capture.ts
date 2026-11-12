import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

interface CaptureOutcome {
  code: number;
  stderr: string;
}

export type CaptureMode = "region" | "screen";

type CaptureResult =
  | { status: "captured"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function buildCaptureFilename(now: Date): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`;
  return `blink-${stamp}.png`;
}

const MODE_ARGS: Record<CaptureMode, string[]> = {
  region: ["-i", "-s", "-x"],
  screen: ["-m", "-x"],
};

const runScreencapture = (file: string, mode: CaptureMode): Promise<CaptureOutcome> =>
  new Promise((resolve) => {
    const child = spawn("screencapture", [...MODE_ARGS[mode], file], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => resolve({ code: -1, stderr: error.message }));
    child.once("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });

/**
 * Write a capture into `targetDir`: `region` prompts for a selection, `screen`
 * grabs the main display immediately.
 *
 * Escape cancels a region capture and writes nothing, which `screencapture`
 * reports as a non-zero exit with no stderr — the same exit code it uses for
 * real failures such as a missing Screen Recording grant, so the two are told
 * apart by whether anything was written to stderr.
 */
export async function capture(
  targetDir: string,
  mode: CaptureMode,
): Promise<CaptureResult> {
  const file = path.join(targetDir, buildCaptureFilename(new Date()));
  const { code, stderr } = await runScreencapture(file, mode);
  const message = stderr.trim();

  if (message !== "") return { status: "failed", message };
  if (code !== 0) return { status: "cancelled" };
  if (!existsSync(file)) return { status: "cancelled" };
  return { status: "captured", path: file };
}
