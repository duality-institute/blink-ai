import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, screen } from "electron";
import {
  CHANNEL_SETTINGS_DISMISS,
  CHANNEL_SETTINGS_LOAD_ANSWERS,
  CHANNEL_SETTINGS_LOAD_PROMPTS,
  CHANNEL_SETTINGS_LOAD_TRANSCRIPTS,
  CHANNEL_SETTINGS_READ_TRANSCRIPT,
  CHANNEL_SETTINGS_SAVE_PROMPTS,
  CHANNEL_SETTINGS_SHOW_TAB,
  type AnswerLogEntry,
  type TranscriptSessionEntry,
  type PromptsPayload,
  type SettingsTab,
} from "./ipc";

const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 620;

export type SettingsCallbacks = {
  readonly loadPrompts: () => PromptsPayload;
  readonly savePrompts: (prompts: {
    readonly monitorPrompt: string;
    readonly meetingPrompt: string;
  }) => void;
  readonly loadAnswers: () => readonly AnswerLogEntry[];
  readonly loadTranscripts: (query: string) => readonly TranscriptSessionEntry[];
  readonly readTranscript: (file: string) => string;
};

function rendererFile(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer", name);
}

function preloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");
}

export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private handlersBound = false;

  constructor(private readonly callbacks: SettingsCallbacks) {}

  show(tab: SettingsTab): void {
    this.bindHandlers();
    const win = this.ensureWindow();
    const send = (): void => win.webContents.send(CHANNEL_SETTINGS_SHOW_TAB, tab);
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
    else send();
    win.show();
    win.focus();
  }

  close(): void {
    this.window?.destroy();
    this.window = null;
  }

  private bindHandlers(): void {
    if (this.handlersBound) return;
    this.handlersBound = true;
    ipcMain.handle(CHANNEL_SETTINGS_LOAD_PROMPTS, () => this.callbacks.loadPrompts());
    ipcMain.handle(CHANNEL_SETTINGS_SAVE_PROMPTS, (_event, prompts: unknown) => {
      const value = prompts as { monitorPrompt?: unknown; meetingPrompt?: unknown };
      this.callbacks.savePrompts({
        monitorPrompt: typeof value.monitorPrompt === "string" ? value.monitorPrompt : "",
        meetingPrompt: typeof value.meetingPrompt === "string" ? value.meetingPrompt : "",
      });
    });
    ipcMain.handle(CHANNEL_SETTINGS_LOAD_ANSWERS, () => this.callbacks.loadAnswers());
    ipcMain.handle(CHANNEL_SETTINGS_LOAD_TRANSCRIPTS, (_event, query: unknown) =>
      this.callbacks.loadTranscripts(typeof query === "string" ? query : ""),
    );
    ipcMain.handle(CHANNEL_SETTINGS_READ_TRANSCRIPT, (_event, file: unknown) =>
      typeof file === "string" ? this.callbacks.readTranscript(file) : "",
    );
    ipcMain.on(CHANNEL_SETTINGS_DISMISS, () => this.close());
  }

  private ensureWindow(): BrowserWindow {
    if (this.window?.isDestroyed() === false) return this.window;
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WINDOW_WIDTH, workArea.width - 80);
    const height = Math.min(WINDOW_HEIGHT, workArea.height - 80);
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 560,
      minHeight: 420,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      title: "Blink",
      titleBarStyle: "hiddenInset",
      backgroundColor: "#ffffff",
      show: false,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.on("closed", () => {
      this.window = null;
    });
    void win.loadFile(rendererFile("settings.html"));
    this.window = win;
    return win;
  }
}
