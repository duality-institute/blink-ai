import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AnswerRecord } from "./types";
import { getBlinkHome } from "./config";

const StoredAnswerSchema = z.object({
  timestamp: z.string().min(1),
  source: z
    .enum(["monitor", "meeting", "screenshot", "transcript"])
    .optional(),
  screenshotPaths: z.array(z.string()).optional(),
  screenshotPath: z.string().optional(),
  answer: z.string(),
  durationMs: z.number().nonnegative(),
});

/**
 * Append an answer record to the answer log (JSONL format).
 * Creates the parent directory if it doesn't exist.
 * Appends one complete JSON object per line, newline-terminated.
 * Never stores image bytes or base64 data.
 *
 * @param record - The answer record to append
 * @throws Error if file operations fail
 */
export function appendAnswer(record: AnswerRecord): void {
  const blinkHome = getBlinkHome();
  const logPath = path.join(blinkHome, "answers.jsonl");

  // Ensure the directory exists
  if (!fs.existsSync(blinkHome)) {
    fs.mkdirSync(blinkHome, { recursive: true });
  }

  // Serialize the record to JSON and append as a single line
  const line = JSON.stringify(record) + "\n";

  // Append to the file (create if missing)
  fs.appendFileSync(logPath, line, "utf-8");
}

function normalizeStoredAnswer(value: unknown): AnswerRecord | null {
  const parsed = StoredAnswerSchema.safeParse(value);
  if (!parsed.success) return null;
  const stored = parsed.data;
  const source =
    stored.source === "meeting" || stored.source === "transcript"
      ? "meeting"
      : "monitor";
  const screenshotPaths =
    stored.screenshotPaths ??
    (stored.screenshotPath === undefined || stored.screenshotPath.length === 0
      ? []
      : [stored.screenshotPath]);
  return {
    timestamp: stored.timestamp,
    source,
    screenshotPaths,
    answer: stored.answer,
    durationMs: stored.durationMs,
  };
}

/**
 * Read the last n records from the answer log.
 * Returns an empty array if the file doesn't exist.
 * Handles malformed lines gracefully (skips them).
 *
 * @param n - Number of recent records to read
 * @returns Array of parsed AnswerRecord objects (up to n records)
 */
export function readRecent(n: number): AnswerRecord[] {
  if (n <= 0) return [];
  const blinkHome = getBlinkHome();
  const logPath = path.join(blinkHome, "answers.jsonl");

  // Return empty array if file doesn't exist
  if (!fs.existsSync(logPath)) {
    return [];
  }

  // Read the entire file
  const content = fs.readFileSync(logPath, "utf-8");

  // Split by newlines and filter out empty lines
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  // Parse each line and collect records
  const records: AnswerRecord[] = [];
  for (const line of lines) {
    try {
      const record = normalizeStoredAnswer(JSON.parse(line));
      if (record !== null) records.push(record);
    } catch {
      // Skip malformed lines silently
      continue;
    }
  }

  // Return the last n records
  return records.slice(-n);
}
