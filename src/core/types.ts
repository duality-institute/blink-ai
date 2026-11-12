/**
 * Core domain types for the screenshot answerer.
 * This module is runtime-agnostic: uses only node: builtins, no electron or bun-only APIs.
 */

/**
 * Configuration for the Blink screenshot answerer.
 * Represents the RESOLVED configuration after defaults are applied.
 * Loaded from ~/.blink-ai/config.json (or $BLINK_HOME/config.json if set).
 *
 * On disk, every key is optional — an empty `{}` is valid and yields all defaults.
 * After loading via `loadConfig()`, the local backend and preferences are
 * populated. `projectDir` remains undefined unless explicitly configured.
 */
export const BLINK_BACKENDS = ["opencode", "codex", "claude"] as const;
export type BlinkBackend = (typeof BLINK_BACKENDS)[number];

export const BACKEND_LABELS: Readonly<Record<BlinkBackend, string>> = {
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
};

export const BACKEND_COMMANDS: Readonly<Record<BlinkBackend, string>> = {
  opencode: "opencode",
  codex: "codex",
  claude: "claude",
};

/**
 * Capture accelerators are fixed, not configurable: `globalShortcut.register`
 * throws on a malformed string and returns false on one another app already
 * claims, so the shipped pair is verified instead of validated at runtime.
 */
export const CAPTURE_ACCELERATORS = {
  region: "CommandOrControl+Shift+2",
  screen: "CommandOrControl+Shift+1",
} as const;

export const CLEAR_IMAGES_ACCELERATOR = "CommandOrControl+Shift+0";

export interface BlinkConfig {
  backend: BlinkBackend;

  /** Backend working directory; defaults to ~/.blink-ai/scratch. */
  projectDir?: string;

  /** OpenCode uses provider/model; Claude Code and Codex use native model IDs. */
  model?: string;

  /**
   * When true the popup is excluded from screenshots and screen sharing.
   * Always populated after loading.
   */
  hideFromCapture: boolean;

  /**
   * Legacy persisted preference. Meeting now always shows the transcript;
   * Monitor never does. This value is no longer used by the popup.
   */
  showTranscript: boolean;

  /**
   * Replaces the built-in instruction for Monitor screenshots.
   * Empty means use the local default.
   */
  monitorPrompt: string;

  /**
   * Replaces the built-in instruction for Meeting asks.
   * Empty means use the local default.
   */
  meetingPrompt: string;
}

/**
 * A single answer record written to the answer log (JSONL format).
 * No image bytes are stored; only metadata and text.
 */
export interface AnswerRecord {
  /** ISO 8601 timestamp when the answer was generated. */
  timestamp: string;

  source: "monitor" | "meeting";

  screenshotPaths: readonly string[];

  /** The generated answer text. */
  answer: string;

  /** Time taken to generate the answer in milliseconds. */
  durationMs: number;
}

/**
 * Streaming event: a chunk of the answer text has arrived.
 */
export interface AnswerDelta {
  type: "delta";
  /** Partial text chunk. */
  text: string;
}

/**
 * Streaming event: the answer is complete.
 */
export interface AnswerComplete {
  type: "complete";
  /** Full answer text. */
  text: string;
  /** True if the final text was recovered via a fallback path (e.g., after SSE drop). */
  reconciled: boolean;
}

/**
 * Streaming event: an error occurred while generating the answer.
 */
export interface AnswerError {
  type: "error";
  /** Error message. */
  message: string;
}
