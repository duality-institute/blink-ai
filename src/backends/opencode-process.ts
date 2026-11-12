import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type OpenCodeProcessOptions = {
  readonly binary: string;
  readonly port: number;
  readonly workingDirectory: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
};

export type OpenCodeEndpoint = {
  readonly url: string;
  readonly password: string;
};

type Child = ChildProcessByStdio<null, Readable, Readable>;

const LISTENING_LINE = /opencode server listening on\s+(https?:\/\/\S+)/;
const CONFIG_OVERRIDE = Object.freeze({
  attachment: Object.freeze({
    image: Object.freeze({
      max_width: 4096,
      max_height: 4096,
      max_base64_bytes: 20_000_000,
    }),
  }),
});

function appendTail(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-8192);
}

function kill(child: Child, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export class OpenCodeProcess {
  private readonly options: OpenCodeProcessOptions;
  private readonly password = randomBytes(32).toString("base64url");
  private readonly exitPromise: Promise<Error | null>;
  private resolveExit: (error: Error | null) => void = () => undefined;
  private child: Child | null = null;
  private startPromise: Promise<OpenCodeEndpoint> | null = null;
  private stopping = false;

  constructor(options: OpenCodeProcessOptions) {
    this.options = options;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  start(): Promise<OpenCodeEndpoint> {
    if (this.startPromise !== null) return this.startPromise;
    if (this.stopping) return Promise.reject(new Error("OpenCode process is stopped"));
    this.startPromise = this.spawn();
    return this.startPromise;
  }

  waitForExit(): Promise<Error | null> {
    return this.exitPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === null) {
      this.resolveExit(null);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(escalation);
        resolve();
      };
      child.once("exit", finish);
      const escalation = setTimeout(() => {
        if (!settled) kill(child, "SIGKILL");
      }, this.options.shutdownTimeoutMs ?? 3_000);
      if (!kill(child, "SIGTERM")) finish();
    });
    if (this.child === child) this.child = null;
  }

  private spawn(): Promise<OpenCodeEndpoint> {
    fs.mkdirSync(this.options.workingDirectory, { recursive: true });
    return new Promise((resolve, reject) => {
      let child: Child;
      try {
        child = spawn(
          this.options.binary,
          [
            "serve",
            "--hostname=127.0.0.1",
            `--port=${this.options.port}`,
          ],
          {
            cwd: this.options.workingDirectory,
            env: {
              ...process.env,
              ...this.options.environment,
              OPENCODE_SERVER_PASSWORD: this.password,
              OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG_OVERRIDE),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        reject(
          new Error(
            `Failed to spawn OpenCode: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      this.child = child;
      let ready = false;
      let stdout = "";
      let stderr = "";
      let startupSettled = false;
      const settleFailure = (error: Error): void => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          kill(child, "SIGKILL");
        }
        reject(error);
      };
      const timeout = setTimeout(() => {
        const detail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`;
        settleFailure(new Error(`OpenCode startup timed out${detail}`));
      }, this.options.startupTimeoutMs ?? 30_000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (ready) return;
        stdout += chunk;
        let newline = stdout.indexOf("\n");
        while (newline !== -1) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          const match = LISTENING_LINE.exec(line);
          const url = match?.[1];
          if (url !== undefined) {
            ready = true;
            startupSettled = true;
            clearTimeout(timeout);
            resolve({ url, password: this.password });
            return;
          }
          newline = stdout.indexOf("\n");
        }
        if (stdout.length > 65_536) stdout = stdout.slice(-65_536);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = appendTail(stderr, chunk);
      });
      child.once("error", (error) => {
        settleFailure(new Error(`OpenCode process error: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (this.child === child) this.child = null;
        if (!ready) {
          settleFailure(
            new Error(
              `OpenCode exited before ready (code=${code}, signal=${signal})`,
            ),
          );
          return;
        }
        this.resolveExit(
          this.stopping
            ? null
            : new Error(`OpenCode exited (code=${code}, signal=${signal})`),
        );
      });
    });
  }
}
