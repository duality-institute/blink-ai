import type { TranscriptHistoryLine, TranscriptSpeaker } from "./transcript-history";

export interface MeetingTranscriptChunk {
  readonly text: string;
  /** Finalized ids to mark submitted once the gateway accepts the answer. */
  readonly lineIds: readonly string[];
  readonly hasNewSpeech: boolean;
}

const speakerLabel: Record<TranscriptSpeaker, string> = {
  them: "Them",
  you: "You",
};

const EMPTY_CHUNK = "No new speech since the last ask.";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function offset(startMs: number): string {
  const total = Math.max(0, Math.floor(startMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Chooses which transcript lines each Meeting ask carries.
 *
 * Every ask continues one server-side conversation, so a line is sent once and
 * never repeated: the model already holds the earlier chunks. Lines are tracked
 * by id rather than by timestamp because speech finalizes late — a sentence can
 * start before an ask and settle after it, and a clock-based cut would either
 * drop that line or send it twice.
 */
export class MeetingTranscriptCursor {
  private readonly submitted = new Set<string>();

  get submittedCount(): number {
    return this.submitted.size;
  }

  /**
   * The in-progress line is included but never marked submitted: it is usually
   * the question being asked right now, and its finalized text arrives in the
   * next chunk.
   */
  chunk(
    lines: readonly TranscriptHistoryLine[],
    volatile: readonly TranscriptHistoryLine[] = [],
  ): MeetingTranscriptChunk {
    const pending = lines.filter((line) => !this.submitted.has(line.id));
    if (pending.length === 0 && volatile.length === 0) {
      return { text: EMPTY_CHUNK, lineIds: [], hasNewSpeech: false };
    }

    const continues = this.submitted.size > 0;
    const spoken = [
      ...pending.map(
        (line) => `${speakerLabel[line.speaker]} (${offset(line.startMs)}): ${line.text}`,
      ),
      ...volatile.map(
        (line) =>
          `${speakerLabel[line.speaker]} (${offset(line.startMs)}, in progress): ${line.text}`,
      ),
    ];
    const first = pending[0] ?? volatile[0];
    const last = volatile[volatile.length - 1] ?? pending[pending.length - 1];
    const span =
      first === undefined || last === undefined
        ? ""
        : ` ${offset(first.startMs)}-${offset(last.startMs)}`;
    const heading = continues
      ? `Transcript${span} (new since the last ask)`
      : `Transcript${span}`;

    return {
      text: `${heading}\n\n${spoken.join("\n")}`,
      lineIds: pending.map((line) => line.id),
      hasNewSpeech: true,
    };
  }

  markSubmitted(lineIds: readonly string[]): void {
    for (const id of lineIds) this.submitted.add(id);
  }

  /**
   * Forgets what was sent so the next ask carries the whole meeting again.
   * Used when the gateway has dropped the conversation and the model would
   * otherwise receive a chunk that continues a history it no longer has.
   */
  reset(): void {
    this.submitted.clear();
  }
}
