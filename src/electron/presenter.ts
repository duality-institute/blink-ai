import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadPresenterNotes,
  savePresenterNotes,
} from "../core/presenter-notes";
import {
  CHANNEL_PRESENTER_DISMISS,
  CHANNEL_PRESENTER_LOAD,
  CHANNEL_PRESENTER_PRIVACY_CHANGED,
  CHANNEL_PRESENTER_SAVE,
  CHANNEL_PRESENTER_SCROLL,
  CHANNEL_PRESENTER_SET_PRIVACY,
  type PresenterScrollDirection,
  type PresenterStatePayload,
} from "./ipc";

const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 560;
const WINDOW_MARGIN = 24;

interface PresenterNotesOptions {
  filePath: string;
  hideFromCapture: boolean;
  onPrivacyChange: (hidden: boolean) => void;
  onVisibilityChange: (visible: boolean) => void;
}

function preloadPath(): string {
  return path.join(app.getAppPath(), "dist", "electron", "preload.cjs");
}

function rendererUrl(): string {
  return pathToFileURL(
    path.join(
      app.getAppPath(),
      "dist",
      "electron",
      "renderer",
      "presenter.html",
    ),
  ).toString();
}

export class PresenterNotesController {
  private window: BrowserWindow | null = null;
  private hideFromCapture: boolean;
  private ipcInstalled = false;
  private shuttingDown = false;

  private readonly loadHandler = (): PresenterStatePayload => ({
    markdown: loadPresenterNotes(this.options.filePath),
    hideFromCapture: this.hideFromCapture,
  });

  private readonly saveHandler = (
    _event: IpcMainInvokeEvent,
    markdown: unknown,
  ): void => {
    if (typeof markdown !== "string") {
      throw new Error("Presenter notes must be a string");
    }
    savePresenterNotes(this.options.filePath, markdown);
  };

  private readonly dismissListener = (): void => {
    this.hide();
  };

  private readonly privacyListener = (
    _event: IpcMainEvent,
    hidden: unknown,
  ): void => {
    if (typeof hidden === "boolean") {
      this.options.onPrivacyChange(hidden);
    }
  };

  constructor(private readonly options: PresenterNotesOptions) {
    this.hideFromCapture = options.hideFromCapture;
  }

  registerIpcHandlers(): void {
    if (this.ipcInstalled) return;
    ipcMain.handle(CHANNEL_PRESENTER_LOAD, this.loadHandler);
    ipcMain.handle(CHANNEL_PRESENTER_SAVE, this.saveHandler);
    ipcMain.on(CHANNEL_PRESENTER_DISMISS, this.dismissListener);
    ipcMain.on(CHANNEL_PRESENTER_SET_PRIVACY, this.privacyListener);
    this.ipcInstalled = true;
  }

  show(): void {
    const win = this.ensureWindow();
    const wasVisible = win.isVisible();
    win.setContentProtection(this.hideFromCapture);
    win.show();
    win.focus();
    if (!wasVisible) this.options.onVisibilityChange(true);
  }

  hide(): void {
    if (this.window?.isDestroyed() !== false) return;
    if (this.window.isVisible()) {
      this.window.hide();
      this.options.onVisibilityChange(false);
    }
  }

  setHiddenFromCapture(hidden: boolean): void {
    this.hideFromCapture = hidden;
    if (this.window?.isDestroyed() === false) {
      this.window.setContentProtection(hidden);
      this.window.webContents.send(CHANNEL_PRESENTER_PRIVACY_CHANGED, hidden);
    }
  }

  scroll(direction: PresenterScrollDirection): void {
    if (this.window?.isDestroyed() !== false || !this.window.isVisible()) return;
    this.window.webContents.send(CHANNEL_PRESENTER_SCROLL, direction);
  }

  destroy(): void {
    this.shuttingDown = true;
    if (this.window?.isDestroyed() === false) {
      if (this.window.isVisible()) this.options.onVisibilityChange(false);
      this.window.removeAllListeners("close");
      this.window.destroy();
    }
    this.window = null;
    if (this.ipcInstalled) {
      ipcMain.removeHandler(CHANNEL_PRESENTER_LOAD);
      ipcMain.removeHandler(CHANNEL_PRESENTER_SAVE);
      ipcMain.removeListener(CHANNEL_PRESENTER_DISMISS, this.dismissListener);
      ipcMain.removeListener(
        CHANNEL_PRESENTER_SET_PRIVACY,
        this.privacyListener,
      );
      this.ipcInstalled = false;
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window?.isDestroyed() === false) return this.window;

    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WINDOW_WIDTH, workArea.width - WINDOW_MARGIN * 2);
    const height = Math.min(WINDOW_HEIGHT, workArea.height - WINDOW_MARGIN * 2);
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 520,
      minHeight: 360,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      type: "panel",
      hasShadow: true,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setContentProtection(this.hideFromCapture);
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("close", (event) => {
      if (!this.shuttingDown) {
        event.preventDefault();
        this.hide();
      }
    });
    win.webContents.on("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send(
          CHANNEL_PRESENTER_PRIVACY_CHANGED,
          this.hideFromCapture,
        );
      }
    });
    void win.loadURL(rendererUrl());

    this.window = win;
    return win;
  }
}
