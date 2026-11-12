import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chromium,
  type Browser,
  type LaunchOptions,
  type Page,
  type ViewportSize,
} from "playwright";
import type {
  AnswerDonePayload,
  AnswerStartPayload,
  BlinkAPI,
  BlinkMode,
  PopupHeaderPayload,
  PopupMeetingPayload,
  PopupMonitoringPayload,
  TranscriptUpdatePayload,
} from "../ipc";

type BridgeState = {
  header: PopupHeaderPayload;
  modeRequests: BlinkMode[];
  askRequests: number;
  onAnswerStart?: (payload: AnswerStartPayload) => void;
  onAnswerDone?: (payload: AnswerDonePayload) => void;
  onHeaderChanged?: (payload: PopupHeaderPayload) => void;
  onMonitoringChanged?: (payload: PopupMonitoringPayload) => void;
  onMeetingChanged?: (payload: PopupMeetingPayload) => void;
  onTranscriptUpdate?: (payload: TranscriptUpdatePayload) => void;
};

type HarnessWindow = Window & {
  blink: BlinkAPI;
  __blinkTest: BridgeState;
};

const DEFAULT_HEADER: PopupHeaderPayload = {
  hideFromCapture: true,
  monitoring: false,
  monitoringStarting: false,
  meeting: false,
  meetingStarting: false,
  asking: false,
  showTranscript: true,
  screenshotCount: 0,
};

async function popupBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "popup.ts")],
    target: "browser",
  });
  if (!result.success) {
    throw new Error(`popup bundle failed: ${JSON.stringify(result.logs)}`);
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error("popup bundle produced no output");
  return output.text();
}

function popupHtml(styled: boolean): string {
  let html = readFileSync(resolve(import.meta.dir, "popup.html"), "utf8")
    .replace(
      /\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
      "",
    )
    .replace(/\s*<script src="\.\/popup\.js"><\/script>/, "");
  if (styled) {
    const css = readFileSync(resolve(import.meta.dir, "popup.css"), "utf8");
    html = html.replace("</head>", `<style>${css}</style></head>`);
  }
  return html;
}

export type PopupHarness = {
  readonly browser: Browser;
  readonly page: Page;
};

export async function openPopup(options?: {
  readonly header?: PopupHeaderPayload;
  readonly channel?: LaunchOptions["channel"];
  readonly styled?: boolean;
  readonly viewport?: ViewportSize;
}): Promise<PopupHarness> {
  const browser = await chromium.launch({
    headless: true,
    ...(options?.channel === undefined ? {} : { channel: options.channel }),
  });
  const page = await browser.newPage({
    viewport: options?.viewport ?? { width: 420, height: 320 },
  });
  await page.setContent(popupHtml(options?.styled ?? true));
  await page.evaluate((header) => {
    const target = window as unknown as HarnessWindow;
    target.__blinkTest = {
      header,
      modeRequests: [],
      askRequests: 0,
    };
    target.blink = {
      loadHeader: async () => target.__blinkTest.header,
      onHeaderChanged: (callback) => {
        target.__blinkTest.onHeaderChanged = callback;
      },
      onAnswerStart: (callback) => {
        target.__blinkTest.onAnswerStart = callback;
      },
      onAnswerDelta() {},
      onAnswerDone: (callback) => {
        target.__blinkTest.onAnswerDone = callback;
      },
      onAnswerError() {},
      abort() {},
      dismiss() {},
      setPrivacy() {},
      onPrivacyChanged() {},
      setMode: (mode) => {
        target.__blinkTest.modeRequests.push(mode);
      },
      onMonitoringChanged: (callback) => {
        target.__blinkTest.onMonitoringChanged = callback;
      },
      askMeeting: () => {
        target.__blinkTest.askRequests += 1;
      },
      setDraft() {},
      onMeetingChanged: (callback) => {
        target.__blinkTest.onMeetingChanged = callback;
      },
      onTranscriptUpdate: (callback) => {
        target.__blinkTest.onTranscriptUpdate = callback;
      },
    };
  }, options?.header ?? DEFAULT_HEADER);
  await page.addScriptTag({ content: await popupBundle() });
  await page.waitForTimeout(25);
  return { browser, page };
}

export async function emitMeeting(
  page: Page,
  payload: PopupMeetingPayload,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as HarnessWindow).__blinkTest.onMeetingChanged?.(next);
  }, payload);
}

export async function emitMonitoring(
  page: Page,
  payload: PopupMonitoringPayload,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as HarnessWindow).__blinkTest.onMonitoringChanged?.(next);
  }, payload);
}

export async function emitAnswerStart(
  page: Page,
  payload: AnswerStartPayload,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as HarnessWindow).__blinkTest.onAnswerStart?.(next);
  }, payload);
}

export async function emitAnswerDone(
  page: Page,
  payload: AnswerDonePayload,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as HarnessWindow).__blinkTest.onAnswerDone?.(next);
  }, payload);
}

export async function emitTranscript(
  page: Page,
  payload: TranscriptUpdatePayload,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as HarnessWindow).__blinkTest.onTranscriptUpdate?.(next);
  }, payload);
}
