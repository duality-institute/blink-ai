import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, screen } from "electron";
import {
  CHANNEL_WELCOME_DISMISS,
  CHANNEL_WELCOME_LOAD,
  CHANNEL_WELCOME_REQUEST,
  CHANNEL_WELCOME_RESTART,
} from "./ipc";
import { currentPermissionStates, requestPermission } from "./permissions";
import { PERMISSION_KINDS, type PermissionKind, type PermissionStates } from "./welcome-steps";

const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 560;

export type WelcomeCallbacks = {
  readonly restart: () => void;
  readonly onDismiss: () => void;
};

function rendererFile(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer", name);
}

function preloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");
}

function isPermissionKind(value: unknown): value is PermissionKind {
  return PERMISSION_KINDS.some((kind) => kind === value);
}

export class WelcomeWindow {
  private window: BrowserWindow | null = null;
  private handlersBound = false;

  constructor(private readonly callbacks: WelcomeCallbacks) {}

  show(): void {
    this.bindHandlers();
    const win = this.ensureWindow();
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
    ipcMain.handle(CHANNEL_WELCOME_LOAD, () => currentPermissionStates());
    ipcMain.handle(CHANNEL_WELCOME_REQUEST, async (_event, kind: unknown): Promise<PermissionStates> => {
      if (isPermissionKind(kind)) await requestPermission(kind);
      return currentPermissionStates();
    });
    ipcMain.on(CHANNEL_WELCOME_RESTART, () => this.callbacks.restart());
    ipcMain.on(CHANNEL_WELCOME_DISMISS, () => {
      this.close();
      this.callbacks.onDismiss();
    });
  }

  private ensureWindow(): BrowserWindow {
    if (this.window?.isDestroyed() === false) return this.window;
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WINDOW_WIDTH, workArea.width - 80);
    const height = Math.min(WINDOW_HEIGHT, workArea.height - 80);
    const win = new BrowserWindow({
      width,
      height,
      resizable: false,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      title: "Welcome to Blink",
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
    void win.loadFile(rendererFile("welcome.html"));
    this.window = win;
    return win;
  }
}
