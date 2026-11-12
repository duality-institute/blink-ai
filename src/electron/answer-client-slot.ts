/**
 * Holds the desktop's one local answer client.
 *
 * Creating a client can start a backend process (OpenCode runs a private local
 * server), so concurrent requests share one pending creation instead of each
 * starting their own. Releasing waits for that creation to settle and disposes
 * whatever it produced, so no backend process outlives a backend change or
 * shutdown, and the next client starts only after the previous one is gone.
 */

import type { AnswerClient, AnswerPrompts } from "../core/answer-client";
import type { BlinkConfig } from "../core/types";

export type AnswerClientFactory = (config: BlinkConfig) => Promise<AnswerClient>;

const RELEASED_MESSAGE = "The answer backend changed while it was starting";

export class ClientReleasedError extends Error {
  override readonly name = "ClientReleasedError";
}

export class AnswerClientSlot {
  private client: AnswerClient | null = null;
  private pending: Promise<AnswerClient> | null = null;
  /** Bumped by every release, so a creation knows when it was abandoned. */
  private generation = 0;
  /** Settles once every client released so far has been disposed. */
  private drained: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly factory: AnswerClientFactory,
    private prompts: AnswerPrompts,
  ) {}

  current(): AnswerClient | null {
    return this.client;
  }

  acquire(config: BlinkConfig): Promise<AnswerClient> {
    if (this.client !== null) return Promise.resolve(this.client);
    this.pending ??= this.create(config, this.generation);
    return this.pending;
  }

  /** Applies to the next Ask, including one whose client is still starting. */
  setPrompts(prompts: AnswerPrompts): void {
    this.prompts = prompts;
    this.client?.setPrompts(prompts);
  }

  release(): Promise<void> {
    this.generation += 1;
    const pending = this.pending;
    const client = this.client;
    this.pending = null;
    this.client = null;
    const released = this.drained.then(async () => {
      // An abandoned creation disposes its own client before it settles.
      if (pending !== null) await Promise.allSettled([pending]);
      await client?.dispose();
    });
    this.drained = Promise.allSettled([released]);
    return released;
  }

  private async create(config: BlinkConfig, generation: number): Promise<AnswerClient> {
    await this.drained;
    if (generation !== this.generation) throw new ClientReleasedError(RELEASED_MESSAGE);
    let client: AnswerClient;
    try {
      client = await this.factory(config);
    } catch (error) {
      if (generation === this.generation) this.pending = null;
      throw error;
    }
    if (generation !== this.generation) {
      await client.dispose();
      throw new ClientReleasedError(RELEASED_MESSAGE);
    }
    this.pending = null;
    client.setPrompts(this.prompts);
    this.client = client;
    return client;
  }
}
