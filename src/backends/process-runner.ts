import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";

export interface JsonlProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  onJson(value: unknown): void | Promise<void>;
  onStderr?(text: string): void;
}

export class ProcessAbortedError extends Error {
  override readonly name = "ProcessAbortedError";

  constructor() {
    super("Process aborted");
  }
}

export function findExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isAbsolute(command) || command.includes("/")) {
    return isExecutable(command) ? command : undefined;
  }
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function runJsonlProcess(
  options: JsonlProcessOptions,
): Promise<void> {
  if (options.signal?.aborted) throw new ProcessAbortedError();

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.environment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let aborted = false;
  let spawnError: Error | undefined;
  let stderr = "";
  let forceKillTimer: NodeJS.Timeout | undefined;
  let lineReader: ReturnType<typeof createInterface> | undefined;

  child.stdin.on("error", (error) => {
    if (!("code" in error) || error.code !== "EPIPE") spawnError = error;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });

  const closePromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let settled = false;
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once("close", settle);
    child.once("error", (error) => {
      spawnError = error;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      lineReader?.close();
      settle(null, null);
    });
  });

  const stopProcess = (): void => {
    terminate(child, "SIGTERM");
    if (forceKillTimer !== undefined) return;
    forceKillTimer = setTimeout(() => terminate(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    stopProcess();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  if (options.input === undefined) child.stdin.end();
  else child.stdin.end(options.input);

  let processingError: Error | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lineReader = lines;
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON from ${options.command}: ${line}`);
      }
      await options.onJson(value);
    }
  } catch (error) {
    processingError = toError(error);
    stopProcess();
  } finally {
    lines.close();
  }

  const result = await closePromise;
  options.signal?.removeEventListener("abort", abort);
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);

  if (aborted) throw new ProcessAbortedError();
  if (processingError !== undefined) throw processingError;
  if (spawnError !== undefined) throw spawnError;
  if (result.code !== 0 || result.signal !== null) {
    const status =
      result.signal === null ? `code ${result.code ?? 1}` : `signal ${result.signal}`;
    const detail = stderr.trim();
    throw new Error(
      `${options.command} exited with ${status}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may not have become a group leader before early failure.
    }
  }
  child.kill(signal);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
