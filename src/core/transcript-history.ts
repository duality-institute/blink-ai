export type TranscriptSpeaker = "them" | "you";

export interface TranscriptSegment {
  speaker: TranscriptSpeaker;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
}

export interface TranscriptHistoryLine {
  readonly id: string;
  readonly speaker: TranscriptSpeaker;
  readonly text: string;
  readonly startMs: number;
}

export interface TranscriptHistoryDelta {
  /** Finalized lines added or revised since the previous drain. */
  readonly changed: readonly TranscriptHistoryLine[];
  /** In-progress speech, replaced wholesale on every drain. */
  readonly volatile: readonly TranscriptHistoryLine[];
}

function lineId(speaker: TranscriptSpeaker, startMs: number): string {
  return `${speaker}:${startMs}`;
}

/**
 * Retains every finalized line of the current listening session for display.
 *
 * Holds every line for the life of the meeting: the popup scrolls back as far
 * as the user cares to look, and each ask sends the slice the model has not
 * seen yet. `MeetingTranscriptCursor` decides that slice, so this store only
 * ever accumulates.
 */
export class TranscriptHistory {
  private readonly finalized = new Map<string, TranscriptHistoryLine>();
  private readonly volatile = new Map<TranscriptSpeaker, TranscriptHistoryLine>();
  private readonly pending = new Map<string, TranscriptHistoryLine>();

  get size(): number {
    return this.finalized.size;
  }

  volatileLines(): readonly TranscriptHistoryLine[] {
    return [...this.volatile.values()].sort(
      (left, right) => left.startMs - right.startMs,
    );
  }

  push(segment: TranscriptSegment): void {
    const text = segment.text.trim();
    if (text.length === 0) return;
    if (!Number.isFinite(segment.startMs) || segment.startMs < 0) return;

    const id = lineId(segment.speaker, segment.startMs);
    const line: TranscriptHistoryLine = {
      id,
      speaker: segment.speaker,
      text,
      startMs: segment.startMs,
    };

    if (!segment.isFinal) {
      this.volatile.set(segment.speaker, line);
      return;
    }

    this.volatile.delete(segment.speaker);
    if (this.finalized.get(id)?.text === text) return;
    this.finalized.set(id, line);
    this.pending.set(id, line);
  }

  /** Returns everything the renderer has not seen yet, then forgets it. */
  drain(): TranscriptHistoryDelta {
    const changed = [...this.pending.values()].sort(
      (left, right) => left.startMs - right.startMs,
    );
    this.pending.clear();
    return { changed, volatile: [...this.volatile.values()] };
  }

  lines(): readonly TranscriptHistoryLine[] {
    return [...this.finalized.values()].sort(
      (left, right) => left.startMs - right.startMs,
    );
  }

  clear(): void {
    this.finalized.clear();
    this.volatile.clear();
    this.pending.clear();
  }
}
