import { describe, expect, it } from "bun:test";
import type {
  AnswerClient,
  AnswerPrompts,
  VisionCapabilityResult,
} from "../core/answer-client";
import type { BlinkConfig } from "../core/types";
import { AnswerClientSlot, ClientReleasedError } from "./answer-client-slot";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeClient implements AnswerClient {
  prompts: AnswerPrompts | null = null;
  disposals = 0;

  constructor(private readonly shutdown: Promise<void> = Promise.resolve()) {}

  answerMonitor(): Promise<void> {
    return Promise.resolve();
  }

  answerMeeting(): Promise<void> {
    return Promise.resolve();
  }

  resetSession(): Promise<string> {
    return Promise.resolve("session");
  }

  endSession(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  checkVisionCapability(): Promise<VisionCapabilityResult> {
    return Promise.resolve({ ok: true });
  }

  setPrompts(prompts: AnswerPrompts): void {
    this.prompts = prompts;
  }

  dispose(): Promise<void> {
    this.disposals += 1;
    return this.shutdown;
  }
}

type Creation = {
  readonly config: BlinkConfig;
  readonly result: Deferred<AnswerClient>;
};

function startableFactory(): {
  readonly factory: (config: BlinkConfig) => Promise<AnswerClient>;
  readonly creations: Creation[];
} {
  const creations: Creation[] = [];
  return {
    creations,
    factory: (config) => {
      const result = deferred<AnswerClient>();
      creations.push({ config, result });
      return result.promise;
    },
  };
}

function creation(creations: readonly Creation[], index: number): Creation {
  const found = creations[index];
  if (found === undefined) throw new Error(`client creation ${index} never started`);
  return found;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const OPENCODE: BlinkConfig = {
  backend: "opencode",
  model: "anthropic/claude-opus-5",
  hideFromCapture: true,
  showTranscript: true,
  monitorPrompt: "",
  meetingPrompt: "",
};
const CLAUDE: BlinkConfig = {
  backend: "claude",
  hideFromCapture: true,
  showTranscript: true,
  monitorPrompt: "",
  meetingPrompt: "",
};
const PROMPTS: AnswerPrompts = { monitor: "Monitor default", meeting: "Meeting default" };
const EDITED: AnswerPrompts = { monitor: "Answer in Korean", meeting: "Summarize decisions" };

describe("AnswerClientSlot", () => {
  it("starts one backend for requests that arrive while it is starting", async () => {
    // Given a client that is still starting
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const first = slot.acquire(OPENCODE);

    // When a second request arrives before it is ready
    const second = slot.acquire(OPENCODE);
    await settle();
    const client = new FakeClient();
    creation(creations, 0).result.resolve(client);

    // Then both requests share the one creation
    expect(await first).toBe(client);
    expect(await second).toBe(client);
    expect(creations).toHaveLength(1);
  });

  it("applies prompts saved while the client was starting", async () => {
    // Given a client that is still starting
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const acquired = slot.acquire(OPENCODE);
    await settle();

    // When prompts are saved before it is ready
    slot.setPrompts(EDITED);
    const client = new FakeClient();
    creation(creations, 0).result.resolve(client);
    await acquired;

    // Then the ready client answers with the saved prompts
    expect(client.prompts).toEqual(EDITED);
  });

  it("keeps the session-bearing client when prompts change", async () => {
    // Given a ready client
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const acquired = slot.acquire(OPENCODE);
    await settle();
    const client = new FakeClient();
    creation(creations, 0).result.resolve(client);
    await acquired;

    // When the prompts are saved
    slot.setPrompts(EDITED);

    // Then the same client takes them and nothing restarts
    expect(client.prompts).toEqual(EDITED);
    expect(await slot.acquire(OPENCODE)).toBe(client);
    expect(client.disposals).toBe(0);
    expect(creations).toHaveLength(1);
  });

  it("settles release only after a client that was still starting has shut down", async () => {
    // Given a client that is still starting
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const outcome = slot.acquire(OPENCODE).then(
      () => null,
      (error: unknown) => error,
    );
    await settle();

    // When the slot is released and the creation then completes
    const released = slot.release();
    let releaseSettled = false;
    void released.then(() => {
      releaseSettled = true;
    });
    const shutdown = deferred<void>();
    const late = new FakeClient(shutdown.promise);
    creation(creations, 0).result.resolve(late);
    await settle();

    // Then release waits for the late client's shutdown, and its requester learns why
    expect(late.disposals).toBe(1);
    expect(releaseSettled).toBe(false);
    shutdown.resolve();
    await released;
    expect(await outcome).toBeInstanceOf(ClientReleasedError);
    expect(slot.current()).toBeNull();
  });

  it("starts the next backend only after the released one has shut down", async () => {
    // Given a ready client whose shutdown is still running after release
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const shutdown = deferred<void>();
    const previous = new FakeClient(shutdown.promise);
    const first = slot.acquire(OPENCODE);
    await settle();
    creation(creations, 0).result.resolve(previous);
    await first;
    const released = slot.release();

    // When a request for the newly selected backend arrives
    const next = slot.acquire(CLAUDE);
    await settle();

    // Then the new backend starts only once the previous one is gone
    expect(previous.disposals).toBe(1);
    expect(creations).toHaveLength(1);
    shutdown.resolve();
    await released;
    await settle();
    expect(creations).toHaveLength(2);
    expect(creation(creations, 1).config.backend).toBe("claude");
    const replacement = new FakeClient();
    creation(creations, 1).result.resolve(replacement);
    expect(await next).toBe(replacement);
  });

  it("tries again after a backend fails to start", async () => {
    // Given a start that failed
    const { factory, creations } = startableFactory();
    const slot = new AnswerClientSlot(factory, PROMPTS);
    const failure = slot.acquire(OPENCODE).then(
      () => null,
      (error: unknown) => error,
    );
    await settle();
    creation(creations, 0).result.reject(new Error("opencode is not on PATH"));
    expect(await failure).toHaveProperty("message", "opencode is not on PATH");

    // When the next Ask requests a client
    const retried = slot.acquire(OPENCODE);
    await settle();

    // Then a fresh start is attempted
    expect(creations).toHaveLength(2);
    const client = new FakeClient();
    creation(creations, 1).result.resolve(client);
    expect(await retried).toBe(client);
  });
});
