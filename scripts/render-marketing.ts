import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { BlinkAPI, PopupHeaderPayload } from "../src/electron/ipc";
import { MARKETING_EXAMPLES, MARKETING_TRANSCRIPT } from "./marketing-fixtures";

const output = process.argv[2];
if (!output) throw new Error("Usage: bun scripts/render-marketing.ts <output-directory> [--dark]");
const colorScheme = process.argv.includes("--dark") ? "dark" : "light";
const renderer = resolve(import.meta.dir, "../src/electron/renderer");
const result = await Bun.build({ entrypoints: [resolve(renderer, "popup.ts")], target: "browser" });
if (!result.success || !result.outputs[0]) throw new Error("Popup bundle failed");
const bundle = await result.outputs[0].text();
const css = await readFile(resolve(renderer, "popup.css"), "utf8");
const html = (await readFile(resolve(renderer, "popup.html"), "utf8"))
  .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
  .replace('<link rel="stylesheet" href="./popup.css" />', `<style>${css}</style>`)
  .replace('<script src="./popup.js"></script>', "");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const mode of ["monitor", "meeting"] as const) {
    for (const phase of ["capture", "ask", "answer", "preview", "preview-mobile"] as const) {
      const meeting = mode === "meeting";
      const preview = phase === "preview" || phase === "preview-mobile";
      if (meeting && preview) continue;
      const viewPhase = preview ? "answer" : phase;
      const viewport = phase === "preview" ? { width: 620, height: 496 }
        : phase === "preview-mobile" ? { width: 420, height: 525 }
        : { width: 760, height: 440 };
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
      await page.clock.install({ time: new Date("2026-09-10T10:42:00Z") });
      await page.setContent(html);
      const header: PopupHeaderPayload = {
        hideFromCapture: true, monitoring: !meeting, monitoringStarting: false,
        meeting, meetingStarting: false, asking: viewPhase === "ask", showTranscript: meeting,
        screenshotCount: viewPhase === "answer" ? 0 : 2,
        ...(meeting ? { startedAt: Date.parse("2026-09-10T10:39:46Z") } : {}),
      };
      await page.evaluate(({ header, phase, mode, example, transcript }) => {
        const noop = () => {};
        window.blink = {
          loadHeader: async () => header,
          onHeaderChanged: noop,
          onAnswerStart: (callback) => {
            if (phase !== "capture") callback({ source: mode, title: example.title, detectedAt: "2026-09-10T10:42:00Z" });
          },
          onAnswerDelta: noop,
          onAnswerDone: (callback) => {
            if (phase === "answer") callback({ type: "complete", text: example.answer, reconciled: false, durationMs: 0, cancelled: false });
          },
          onTranscriptUpdate: (callback) => {
            if (mode === "meeting") callback({ reset: true, changed: [...transcript], volatile: [] });
          },
          onAnswerError: noop, abort: noop, dismiss: noop, setPrivacy: noop,
          onPrivacyChanged: noop, onMonitoringChanged: noop, setMode: noop,
          askMeeting: noop, setDraft: noop, onMeetingChanged: noop,
        } satisfies BlinkAPI;
      }, { header, phase: viewPhase, mode, example: MARKETING_EXAMPLES[mode], transcript: MARKETING_TRANSCRIPT });
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => document.getElementById("privacy")?.getAttribute("aria-checked") === "true");
      if (viewPhase === "answer") await page.locator("#answer h2").waitFor();
      if (phase === "ask") {
        await page.locator("#answering").waitFor();
        if (await page.locator("#answer").textContent()) throw new Error("Thinking frame contains an answer");
      }
      await page.screenshot({ path: resolve(output, `${mode}-${phase}.png`), omitBackground: true });
      console.log(`Rendered ${mode}-${phase}: ${viewport.width} × ${viewport.height}`);
      await page.close();
    }
  }
} finally { await browser.close(); }
