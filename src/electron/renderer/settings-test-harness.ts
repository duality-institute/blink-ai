import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page, type ViewportSize } from "playwright";
import type {
  AnswerLogEntry,
  PromptsPayload,
  SettingsTab,
  TranscriptSessionEntry,
} from "../ipc";

type SavedPrompts = { monitorPrompt: string; meetingPrompt: string };

type BridgeState = {
  prompts: PromptsPayload;
  answers: AnswerLogEntry[];
  sessions: TranscriptSessionEntry[];
  transcripts: Record<string, string>;
  saved: SavedPrompts[];
  answerLoads: number;
  transcriptQueries: string[];
  dismissals: number;
  showTab?: (tab: SettingsTab) => void;
};

declare global {
  interface Window {
    __settingsTest: BridgeState;
  }
}

export type SettingsFixture = {
  readonly prompts: PromptsPayload;
  readonly answers: readonly AnswerLogEntry[];
  readonly sessions: readonly TranscriptSessionEntry[];
  readonly transcripts: Readonly<Record<string, string>>;
};

const EMPTY_FIXTURE: SettingsFixture = {
  prompts: {
    monitorPrompt: "",
    meetingPrompt: "",
    monitorDefault: "Monitor default prompt",
    meetingDefault: "Meeting default prompt",
  },
  answers: [],
  sessions: [],
  transcripts: {},
};

async function settingsBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "settings.ts")],
    target: "browser",
  });
  if (!result.success) {
    throw new Error(`settings bundle failed: ${JSON.stringify(result.logs)}`);
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error("settings bundle produced no output");
  return output.text();
}

function settingsHtml(): string {
  const css = readFileSync(resolve(import.meta.dir, "settings.css"), "utf8");
  return readFileSync(resolve(import.meta.dir, "settings.html"), "utf8")
    .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
    .replace(/\s*<link rel="stylesheet" href="settings\.css" \/>/, "")
    .replace(/\s*<script type="module" src="settings\.js"><\/script>/, "")
    .replace("</head>", `<style>${css}</style></head>`);
}

export type SettingsHarness = {
  readonly browser: Browser;
  readonly page: Page;
};

export async function openSettings(options?: {
  readonly fixture?: SettingsFixture;
  readonly viewport?: ViewportSize;
  readonly colorScheme?: "light" | "dark";
}): Promise<SettingsHarness> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: options?.viewport ?? { width: 760, height: 620 },
    colorScheme: options?.colorScheme ?? "light",
  });
  await page.setContent(settingsHtml());
  await page.evaluate((fixture) => {
    const target = window;
    target.__settingsTest = {
      prompts: fixture.prompts,
      answers: [...fixture.answers],
      sessions: [...fixture.sessions],
      transcripts: { ...fixture.transcripts },
      saved: [],
      answerLoads: 0,
      transcriptQueries: [],
      dismissals: 0,
    };
    const test = target.__settingsTest;
    target.settings = {
      loadPrompts: async () => test.prompts,
      savePrompts: async (prompts) => {
        test.saved.push({ ...prompts });
      },
      loadAnswers: async () => {
        test.answerLoads += 1;
        return test.answers;
      },
      loadTranscripts: async (query) => {
        test.transcriptQueries.push(query);
        return test.sessions;
      },
      readTranscript: async (file) => test.transcripts[file] ?? "",
      dismiss: () => {
        test.dismissals += 1;
      },
      onShowTab: (callback) => {
        test.showTab = callback;
      },
    };
  }, options?.fixture ?? EMPTY_FIXTURE);
  await page.addScriptTag({ content: await settingsBundle(), type: "module" });
  await page.waitForTimeout(25);
  return { browser, page };
}

export function bridge(page: Page): Promise<Omit<BridgeState, "showTab">> {
  return page.evaluate(() => {
    const { showTab: _showTab, ...state } = window.__settingsTest;
    return state;
  });
}

export async function showTabFromMain(page: Page, tab: SettingsTab): Promise<void> {
  await page.evaluate((next) => {
    window.__settingsTest.showTab?.(next);
  }, tab);
}
