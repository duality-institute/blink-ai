import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export type AudioSpeaker = "them" | "you";

export interface AudioReadyEvent {
  kind: "ready";
}

export interface AudioStatusEvent {
  kind: "status";
  message: string;
}

export interface AudioTranscriptEvent {
  kind: "transcript";
  speaker: AudioSpeaker;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
}

export interface AudioErrorEvent {
  kind: "error";
  message: string;
}

export type AudioHelperEvent =
  | AudioReadyEvent
  | AudioStatusEvent
  | AudioTranscriptEvent
  | AudioErrorEvent;

export interface AudioCrashEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface AudioRestartEvent {
  attempt: number;
  delayMs: number;
}

export interface AudioManagerOptions {
  binary: string;
  args?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readinessTimeoutMs?: number;
  sigkillDelayMs?: number;
  restartInitialDelayMs?: number;
  restartMaxDelayMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 300_000;
const DEFAULT_SIGKILL_DELAY_MS = 3_000;
const DEFAULT_RESTART_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const MAX_STDERR_LENGTH = 8_192;
const MAX_STDOUT_BUFFER_LENGTH = 65_536;

export class AudioManager extends EventEmitter {
  private readonly binary: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly readinessTimeoutMs: number;
  private readonly sigkillDelayMs: number;
  private readonly restartInitialDelayMs: number;
  private readonly restartMaxDelayMs: number;

  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private ready = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private pendingInitialReject: ((error: Error) => void) | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private nextRestartDelayMs: number;

  constructor(options: AudioManagerOptions) {
    super();
    this.binary = options.binary;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.environment = options.environment ?? process.env;
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.sigkillDelayMs = options.sigkillDelayMs ?? DEFAULT_SIGKILL_DELAY_MS;
    this.restartInitialDelayMs =
      options.restartInitialDelayMs ?? DEFAULT_RESTART_INITIAL_DELAY_MS;
    this.restartMaxDelayMs =
      options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    this.nextRestartDelayMs = this.restartInitialDelayMs;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("AudioManager: stopped"));
    if (this.startPromise !== null) return this.startPromise;

    this.startPromise = new Promise<void>((resolve, reject) => {
      const finishResolve = (): void => {
        this.pendingInitialReject = null;
        resolve();
      };
      const finishReject = (error: Error): void => {
        this.pendingInitialReject = null;
        reject(error);
      };
      this.pendingInitialReject = finishReject;
      this.spawnOnce({ initial: true, resolve: finishResolve, reject: finishReject });
    });
    return this.startPromise;
  }

  isRunning(): boolean {
    return this.child !== null && this.ready;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.pendingInitialReject !== null) {
      this.pendingInitialReject(new Error("AudioManager: stopped during startup"));
      this.pendingInitialReject = null;
    }

    const child = this.child;
    this.ready = false;
    if (child === null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (killTimer !== null) clearTimeout(killTimer);
        resolve();
      };

      child.once("exit", finish);
      if (!tryKill(child, "SIGTERM")) {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        if (!settled) tryKill(child, "SIGKILL");
      }, this.sigkillDelayMs);
    });
    this.child = null;
  }

  private spawnOnce(options: {
    initial: boolean;
    resolve?: () => void;
    reject?: (error: Error) => void;
  }): void {
    if (this.stopping) {
      options.reject?.(new Error("AudioManager: stopped"));
      return;
    }

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(this.binary, [...this.args], {
        cwd: this.cwd,
        env: this.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      options.reject?.(
        new Error(`AudioManager: failed to spawn ${this.binary}: ${toError(error).message}`),
      );
      return;
    }

    this.child = child;
    this.ready = false;
    let childReady = false;
    let failureHandled = false;
    let stdoutBuffer = "";
    let stderrTail = "";

    const readinessTimer = setTimeout(() => {
      fail(
        new Error(
          `AudioManager: readiness timeout after ${this.readinessTimeoutMs}ms${stderrDetail(stderrTail)}`,
        ),
      );
    }, this.readinessTimeoutMs);

    const clearReadinessTimer = (): void => clearTimeout(readinessTimer);

    const fail = (error: Error): void => {
      if (failureHandled) return;
      failureHandled = true;
      clearReadinessTimer();
      this.ready = false;
      this.emit("fatal", { kind: "error", message: error.message } satisfies AudioErrorEvent);
      if (child.exitCode === null && child.signalCode === null) {
        tryKill(child, "SIGKILL");
      }
      if (options.initial && !childReady) {
        options.reject?.(error);
      } else if (!options.initial && !childReady && !this.stopping) {
        this.emit("crash", {
          code: child.exitCode,
          signal: child.signalCode,
          stderr: stderrTail,
        } satisfies AudioCrashEvent);
        this.scheduleRestart();
      }
    };

    const handleEvent = (event: AudioHelperEvent): void => {
      switch (event.kind) {
        case "ready":
          if (childReady) return;
          childReady = true;
          this.ready = true;
          clearReadinessTimer();
          options.resolve?.();
          this.emit("ready", event);
          break;
        case "status":
          this.emit("status", event);
          break;
        case "transcript":
          this.emit("transcript", event);
          break;
        case "error":
          this.emit("fatal", event);
          failureHandled = true;
          clearReadinessTimer();
          this.ready = false;
          if (child.exitCode === null && child.signalCode === null) {
            tryKill(child, "SIGTERM");
          }
          if (options.initial && !childReady) {
            options.reject?.(new Error(`AudioManager: ${event.message}`));
          }
          break;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            handleEvent(parseAudioEvent(line));
          } catch (error) {
            fail(toError(error));
            return;
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > MAX_STDOUT_BUFFER_LENGTH) {
        fail(new Error("AudioManager: invalid NDJSON line exceeds 65536 bytes"));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk, MAX_STDERR_LENGTH);
    });

    child.once("error", (error: Error) => {
      fail(new Error(`AudioManager: child error: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      clearReadinessTimer();
      if (this.child === child) this.child = null;
      this.ready = false;
      if (this.stopping || failureHandled) return;

      if (!childReady) {
        const error = new Error(
          `AudioManager: child exited before ready (code=${code}, signal=${signal})${stderrDetail(stderrTail)}`,
        );
        if (options.initial) {
          options.reject?.(error);
        } else {
          this.emit("crash", { code, signal, stderr: stderrTail } satisfies AudioCrashEvent);
          this.scheduleRestart();
        }
        return;
      }

      this.emit("crash", { code, signal, stderr: stderrTail } satisfies AudioCrashEvent);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== null) return;
    const delayMs = this.nextRestartDelayMs;
    this.nextRestartDelayMs = Math.min(
      this.nextRestartDelayMs * 2,
      this.restartMaxDelayMs,
    );
    this.restartAttempts += 1;
    const attempt = this.restartAttempts;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.emit("restart", { attempt, delayMs } satisfies AudioRestartEvent);
      this.spawnOnce({ initial: false });
    }, delayMs);
  }
}

function parseAudioEvent(line: string): AudioHelperEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`AudioManager: invalid NDJSON: ${line}`);
  }
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    throw new Error(`AudioManager: invalid NDJSON event: ${line}`);
  }

  switch (value["kind"]) {
    case "ready":
      return { kind: "ready" };
    case "status":
    case "error": {
      const message = value["message"];
      if (typeof message !== "string") break;
      return { kind: value["kind"], message };
    }
    case "transcript": {
      const speaker = value["speaker"];
      const text = value["text"];
      const isFinal = value["isFinal"];
      const startMs = value["startMs"];
      const endMs = value["endMs"];
      if (
        (speaker === "them" || speaker === "you") &&
        typeof text === "string" &&
        typeof isFinal === "boolean" &&
        isFiniteNumber(startMs) &&
        isFiniteNumber(endMs)
      ) {
        return { kind: "transcript", speaker, text, isFinal, startMs, endMs };
      }
      break;
    }
  }
  throw new Error(`AudioManager: invalid NDJSON event: ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function appendTail(existing: string, chunk: string, maxLength: number): string {
  const combined = existing + chunk;
  return combined.length <= maxLength
    ? combined
    : combined.slice(combined.length - maxLength);
}

function stderrDetail(stderr: string): string {
  const detail = stderr.trim();
  return detail.length === 0 ? "" : `\nstderr: ${detail}`;
}

function tryKill(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals,
): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
