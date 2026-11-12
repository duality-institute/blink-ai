import * as fs from "node:fs";
import * as path from "node:path";

export interface TranscriptSessionSummary {
  readonly file: string;
  readonly day: string;
  readonly startedAt: string;
  readonly lineCount: number;
  readonly byteSize: number;
  readonly matchCount: number;
}

export interface TranscriptSession extends TranscriptSessionSummary {
  readonly markdown: string;
}

/**
 * Session files are named `YYYY-MM-DD-HHMMSS.md`, optionally with a `-2`
 * disambiguating suffix when two sessions start in the same second.
 */
const SESSION_FILE = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.md$/;
const LEGACY_TITLE = "# Blink transcript\n\n";

function withoutLegacyTitle(markdown: string): string {
  return markdown.startsWith(LEGACY_TITLE)
    ? markdown.slice(LEGACY_TITLE.length)
    : markdown;
}

function parseFileName(
  file: string,
): { day: string; startedAt: string } | undefined {
  const match = SESSION_FILE.exec(file);
  if (match === null) return undefined;
  const [, day, hours, minutes, seconds] = match;
  return { day: day!, startedAt: `${hours}:${minutes}:${seconds}` };
}

function countLines(markdown: string): number {
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("**")) count += 1;
  }
  return count;
}

function countMatches(markdown: string, query: string): number {
  if (query === "") return 0;
  const haystack = markdown.toLowerCase();
  let count = 0;
  let index = haystack.indexOf(query);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(query, index + query.length);
  }
  return count;
}

/**
 * Reading every file per keystroke is affordable because a transcript costs
 * roughly 70 KB per recorded hour, and it keeps the renderer from holding the
 * whole archive in memory just to search it.
 */
export function listTranscriptSessions(
  directory: string,
  query = "",
): readonly TranscriptSessionSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }

  const needle = query.trim().toLowerCase();
  const sessions: TranscriptSessionSummary[] = [];
  for (const file of entries) {
    const parsed = parseFileName(file);
    if (parsed === undefined) continue;
    let markdown: string;
    let byteSize: number;
    try {
      const full = path.join(directory, file);
      byteSize = fs.statSync(full).size;
      markdown = withoutLegacyTitle(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const matchCount = countMatches(markdown, needle);
    if (needle !== "" && matchCount === 0) continue;
    sessions.push({
      file,
      day: parsed.day,
      startedAt: parsed.startedAt,
      lineCount: countLines(markdown),
      byteSize,
      matchCount,
    });
  }

  return sessions.sort((left, right) => right.file.localeCompare(left.file));
}

export function readTranscriptSession(
  directory: string,
  file: string,
): TranscriptSession | undefined {
  const parsed = parseFileName(file);
  if (parsed === undefined) return undefined;

  try {
    const full = path.join(directory, file);
    const markdown = withoutLegacyTitle(fs.readFileSync(full, "utf8"));
    return {
      file,
      day: parsed.day,
      startedAt: parsed.startedAt,
      lineCount: countLines(markdown),
      byteSize: fs.statSync(full).size,
      matchCount: 0,
      markdown,
    };
  } catch {
    return undefined;
  }
}
