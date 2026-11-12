import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import * as path from "node:path";
import {
  AudioManager,
  type AudioCrashEvent,
  type AudioRestartEvent,
  type AudioTranscriptEvent,
} from "./audio-manager";

const FAKE_HELPER = path.join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "fake-audio-helper.ts",
);

let activeManagers: AudioManager[] = [];

afterEach(async () => {
  await Promise.all(activeManagers.map((manager) => manager.stop().catch(() => undefined)));
  activeManagers = [];
});

function makeManager(flags: readonly string[] = []): AudioManager {
  const manager = new AudioManager({
    binary: "bun",
    args: [FAKE_HELPER, ...flags],
    readinessTimeoutMs: 1_000,
    sigkillDelayMs: 200,
    restartInitialDelayMs: 50,
    restartMaxDelayMs: 100,
  });
  activeManagers.push(manager);
  return manager;
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

describe("AudioManager", () => {
  it("starts after a ready event and surfaces status events", async () => {
    const manager = makeManager();
    const statusPromise = once(manager, "status") as Promise<[{ message: string }]>;

    await manager.start();
    const [status] = await statusPromise;

    expect(status.message).toBe("starting");
    expect(manager.isRunning()).toBe(true);
  });

  it("reassembles chunked NDJSON and emits typed transcript events", async () => {
    const manager = makeManager(["--chunk=20", "--transcript"]);
    const transcriptPromise = once(manager, "transcript") as Promise<
      [AudioTranscriptEvent]
    >;

    await manager.start();
    const [transcript] = await transcriptPromise;

    expect(transcript).toEqual({
      kind: "transcript",
      speaker: "them",
      text: "Could you explain the design?",
      isFinal: true,
      startMs: 1_000,
      endMs: 3_000,
    });
  });

  it("rejects startup on malformed NDJSON", async () => {
    const manager = makeManager(["--malformed"]);

    expect(manager.start()).rejects.toThrow("invalid NDJSON");
  });

  it("rejects startup with a helper fatal error", async () => {
    const manager = makeManager(["--fatal=screen capture permission denied"]);

    expect(manager.start()).rejects.toThrow("screen capture permission denied");
  });

  it("emits crash, restart, and ready after an unexpected exit", async () => {
    const manager = makeManager(["--crash-after=50"]);
    await manager.start();
    const crashPromise = once(manager, "crash") as Promise<[AudioCrashEvent]>;
    const restartPromise = once(manager, "restart") as Promise<[AudioRestartEvent]>;
    const readyPromise = once(manager, "ready");

    const [crash] = await crashPromise;
    const [restart] = await restartPromise;
    await readyPromise;

    expect(crash.code).toBe(1);
    expect(crash.stderr).toContain("simulated helper crash");
    expect(restart).toEqual({ attempt: 1, delayMs: 50 });
    expect(manager.isRunning()).toBe(true);
  });

  it("stops gracefully without scheduling a restart", async () => {
    const manager = makeManager();
    await manager.start();
    let restarted = false;
    manager.on("restart", () => {
      restarted = true;
    });

    await manager.stop();
    await timeout(150);

    expect(manager.isRunning()).toBe(false);
    expect(restarted).toBe(false);
  });

  it("escalates to SIGKILL when the helper ignores SIGTERM", async () => {
    const manager = makeManager(["--ignore-sigterm"]);
    await manager.start();
    const startedAt = Date.now();

    await manager.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(manager.isRunning()).toBe(false);
  });
});
