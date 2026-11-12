import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptSpeaker } from "./transcript-history";

export interface TranscriptLogEntry {
  speaker: TranscriptSpeaker;
  text: string;
  startMs: number;
  isFinal: boolean;
}

const speakerLabel: Record<TranscriptSpeaker, string> = {
  them: "Them",
  you: "You",
};

/**
 * Appends finalized transcript lines to one Markdown file per listening
 * session. The file stays on the user's machine and is never submitted.
 */
export class TranscriptLog {
  readonly filePath: string;
  private readonly startedAt: Date;
  private readonly written = new Set<string>();
  private headerWritten = false;

  constructor(directory: string, startedAt: Date = new Date()) {
    this.startedAt = startedAt;
    this.filePath = availablePath(directory, fileStamp(startedAt));
  }

  get lineCount(): number {
    return this.written.size;
  }

  append(entry: TranscriptLogEntry): void {
    if (!entry.isFinal) return;
    const text = entry.text.trim();
    if (text.length === 0) return;

    const key = `${entry.speaker}:${entry.startMs}`;
    if (this.written.has(key)) return;
    this.written.add(key);

    this.ensureHeader();
    const line = `**${speakerLabel[entry.speaker]}** (${offset(entry.startMs)}) ${text}\n\n`;
    fs.appendFileSync(this.filePath, line, "utf8");
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const header = `Started ${readableStamp(this.startedAt)}\n\n`;
    fs.appendFileSync(this.filePath, header, "utf8");
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function offset(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

function fileStamp(date: Date): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-");
}

function readableStamp(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time}`;
}

/** Two sessions can start in the same second; never clobber an earlier file. */
function availablePath(directory: string, stamp: string): string {
  const candidate = path.join(directory, `${stamp}.md`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = path.join(directory, `${stamp}-${suffix}.md`);
    if (!fs.existsSync(next)) return next;
  }
}
