/**
 * Popup window controller.
 *
 * Owns a single frameless, always-on-top, non-activating BrowserWindow that
 * displays streaming answers. The window is reused across answers (hide, never
 * destroy) so its position and last answer survive dismissal, and creation cost
 * is paid once. It stays visible until explicitly dismissed — clicking away
 * does not hide it.
 *
 * The window's renderer receives data exclusively via the
 * `window.blink` bridge defined in `preload.ts`; the controller pushes payloads
 * via `sendStart`, `sendDelta`, `sendDone`, and `sendError`.
 *
 * Positioning is intentionally single-display: `screen.getPrimaryDisplay().workArea`
 * top-right, offset from the menu-bar corner. Multi-monitor logic is out of scope.
 */

import {
  BrowserWindow,
  screen,
  ipcMain,
  app,
  type IpcMainEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AnswerDelta, AnswerError } from "../core/types";
import { UserMessageSchema } from "../core/user-message";
import {
  CHANNEL_ABORT,
  CHANNEL_DISMISS,
  CHANNEL_POPUP_LOAD_HEADER,
  CHANNEL_POPUP_HEADER_CHANGED,
  CHANNEL_POPUP_SET_PRIVACY,
  CHANNEL_POPUP_PRIVACY_CHANGED,
  CHANNEL_POPUP_SET_MODE,
  CHANNEL_POPUP_MONITORING_CHANGED,
  CHANNEL_POPUP_MEETING_CHANGED,
  CHANNEL_POPUP_ASK_MEETING,
  CHANNEL_POPUP_SET_DRAFT,
  type BlinkMode,
  CHANNEL_TRANSCRIPT_UPDATE,
  CHANNEL_ANSWER_START,
  CHANNEL_ANSWER_DELTA,
  CHANNEL_ANSWER_DONE,
  CHANNEL_ANSWER_ERROR,
  type AnswerStartPayload,
  type AnswerDonePayload,
  type PopupHeaderPayload,
  type PopupMonitoringPayload,
  type PopupMeetingPayload,
  type TranscriptUpdatePayload,
} from "./ipc";
import { nextPopupPosition, type PopupMoveDirection } from "./popup-position";

/** Popup window dimensions (CSS pixels). Panel-style, resizable. */
const POPUP_WIDTH = 620;
const POPUP_HEIGHT = 520;
/** Offset from the top-right corner of the primary display's workArea. */
const POPUP_EDGE_MARGIN = 0;
/**
 * Extra width for the meeting transcript column so the answer keeps its own.
 * Must match `.transcript-panel` in popup.css, or turning Meeting on resizes
 * the answer pane instead of leaving it untouched.
 */
const TRANSCRIPT_COLUMN_WIDTH = 400;
const POPUP_MIN_WIDTH = 360;
/** Transcript floor (200px) plus the answer floor (280px) from popup.css. */
const SPLIT_MIN_WIDTH = 480;
const TRANSCRIPT_COLUMN_EXTRA_HEIGHT = 140;

export interface PopupControllerOptions {
  hideFromCapture: boolean;
  onAbort: () => void;
  onVisibilityChange: (visible: boolean) => void;
  onPrivacyChange: (hidden: boolean) => void;
  onModeChange: (mode: BlinkMode) => void;
  onAskMeeting: () => void;
  onDraftChange: (text: string) => void;
  getHeaderState: () => PopupHeaderPayload;
  onRendererReady: () => void;
}

/**
 * Where the built preload script lives at runtime.
 *
 * Electron requires CommonJS preload scripts when sandboxed. Because
 * `package.json` sets `"type": "module"`, a
 * `.js` file would be interpreted as ESM — so the preload is emitted with an
 * explicit `.cjs` extension by `bun build --format=cjs`.
 *
 * `app.getAppPath()` returns the app's root directory (repo root when run
 * as `electron .`); `__dirname` is unreliable in bun-bundled output because
 * bun inlines the source dirname, not the bundle location.
 */
function resolvePreloadPath(): string {
  return path.join(app.getAppPath(), "dist", "electron", "preload.cjs");
}

function resolveRendererIndexUrl(): string {
  const p = path.join(
    app.getAppPath(),
    "dist",
    "electron",
    "renderer",
    "popup.html",
  );
  return pathToFileURL(p).toString();
}

export class PopupController {
  private window: BrowserWindow | null = null;
  private hideFromCapture: boolean;
  private ipcInstalled = false;
  private rendererReady = false;
  private shuttingDown = false;
  private transcriptColumn = false;
  private readonly dismissListener = (): void => {
    this.hide();
  };
  private readonly abortListener = (): void => {
    this.options.onAbort();
  };
  private readonly privacyListener = (
    _event: IpcMainEvent,
    hidden: unknown,
  ): void => {
    if (typeof hidden === "boolean") this.options.onPrivacyChange(hidden);
  };
  private readonly modeListener = (
    _event: IpcMainEvent,
    mode: unknown,
  ): void => {
    if (mode === "off" || mode === "monitor" || mode === "meeting") {
      this.options.onModeChange(mode);
    }
  };
  private readonly askMeetingListener = (): void => {
    this.options.onAskMeeting();
  };
  private readonly draftListener = (_event: IpcMainEvent, value: unknown): void => {
    const parsed = UserMessageSchema.safeParse(value);
    if (parsed.success) this.options.onDraftChange(parsed.data);
  };
  private readonly loadHeaderHandler = (): PopupHeaderPayload =>
    this.options.getHeaderState();
  /** Queued messages that arrive before the renderer has finished loading. */
  private readonly pendingMessages: Array<{
    channel: string;
    payload: unknown;
  }> = [];

  constructor(private readonly options: PopupControllerOptions) {
    this.hideFromCapture = options.hideFromCapture;
  }

  registerIpcHandlers(): void {
    if (this.ipcInstalled) return;
    ipcMain.on(CHANNEL_ABORT, this.abortListener);
    ipcMain.on(CHANNEL_DISMISS, this.dismissListener);
    ipcMain.on(CHANNEL_POPUP_SET_PRIVACY, this.privacyListener);
    ipcMain.on(CHANNEL_POPUP_SET_MODE, this.modeListener);
    ipcMain.on(CHANNEL_POPUP_ASK_MEETING, this.askMeetingListener);
    ipcMain.on(CHANNEL_POPUP_SET_DRAFT, this.draftListener);
    ipcMain.handle(CHANNEL_POPUP_LOAD_HEADER, this.loadHeaderHandler);
    this.ipcInstalled = true;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window !== null && !this.window.isDestroyed()) {
      return this.window;
    }

    const workArea = screen.getPrimaryDisplay().workArea;
    const width = POPUP_WIDTH + (this.transcriptColumn ? TRANSCRIPT_COLUMN_WIDTH : 0);
    const height = Math.min(
      workArea.height,
      POPUP_HEIGHT + (this.transcriptColumn ? TRANSCRIPT_COLUMN_EXTRA_HEIGHT : 0),
    );
    const x = workArea.x + workArea.width - width - POPUP_EDGE_MARGIN;
    const y = workArea.y + POPUP_EDGE_MARGIN;

    const win = new BrowserWindow({
      width,
      height,
      minWidth: this.transcriptColumn ? SPLIT_MIN_WIDTH : POPUP_MIN_WIDTH,
      x,
      y,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      type: "panel",
      backgroundColor: "#00000000",
      transparent: true,
      hasShadow: true,
      webPreferences: {
        preload: resolvePreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setContentProtection(this.hideFromCapture);

    // Float above ordinary windows and full-screen apps.
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });

    // On close (e.g. Cmd+W synthesised by some tools), hide rather than destroy
    // — unless the app is shutting down (controller.destroy() flips the flag).
    win.on("close", (event) => {
      if (!this.shuttingDown) {
        event.preventDefault();
        this.hide();
      }
    });

    this.rendererReady = false;
    win.webContents.on("did-finish-load", () => {
      this.rendererReady = true;
      win.webContents.send(
        CHANNEL_POPUP_PRIVACY_CHANGED,
        this.hideFromCapture,
      );
      // Flush any messages that arrived while the renderer was still loading.
      for (const m of this.pendingMessages) {
        if (!win.isDestroyed()) {
          win.webContents.send(m.channel, m.payload);
        }
      }
      this.pendingMessages.length = 0;
      this.options.onRendererReady();
    });

    void win.loadURL(resolveRendererIndexUrl());

    this.window = win;
    return win;
  }

  setHiddenFromCapture(hidden: boolean): void {
    this.hideFromCapture = hidden;
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.setContentProtection(hidden);
      if (this.rendererReady) {
        this.window.webContents.send(CHANNEL_POPUP_PRIVACY_CHANGED, hidden);
      }
    }
  }

  sendMonitoringChange(payload: PopupMonitoringPayload): void {
    if (
      this.window === null ||
      this.window.isDestroyed() ||
      !this.rendererReady
    ) {
      return;
    }
    this.window.webContents.send(CHANNEL_POPUP_MONITORING_CHANGED, payload);
  }

  sendMeetingChange(payload: PopupMeetingPayload): void {
    if (
      this.window === null ||
      this.window.isDestroyed() ||
      !this.rendererReady
    ) {
      return;
    }
    this.window.webContents.send(CHANNEL_POPUP_MEETING_CHANGED, payload);
  }

  /**
   * Grows the window leftward so the transcript column is added beside the
   * answer instead of squeezing it. The right edge stays put, which keeps the
   * popup anchored where the user parked it.
   */
  setTranscriptColumn(visible: boolean): void {
    if (this.transcriptColumn === visible) return;
    this.transcriptColumn = visible;
    const win = this.window;
    if (win === null || win.isDestroyed()) return;

    const bounds = win.getBounds();
    const delta = visible ? TRANSCRIPT_COLUMN_WIDTH : -TRANSCRIPT_COLUMN_WIDTH;
    const heightDelta = visible
      ? TRANSCRIPT_COLUMN_EXTRA_HEIGHT
      : -TRANSCRIPT_COLUMN_EXTRA_HEIGHT;
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const minimum = visible ? SPLIT_MIN_WIDTH : POPUP_MIN_WIDTH;
    win.setMinimumSize(minimum, 240);
    const height = Math.max(
      240,
      Math.min(workArea.height, bounds.height + heightDelta),
    );
    const y = Math.max(
      workArea.y,
      Math.min(bounds.y, workArea.y + workArea.height - height),
    );
    win.setBounds({
      width: Math.max(minimum, bounds.width + delta),
      height,
      x: Math.max(workArea.x, bounds.x - delta),
      y,
    });
  }

  get rendererLoaded(): boolean {
    return (
      this.window !== null && !this.window.isDestroyed() && this.rendererReady
    );
  }

  sendTranscript(payload: TranscriptUpdatePayload): void {
    if (!this.rendererLoaded) return;
    this.window?.webContents.send(CHANNEL_TRANSCRIPT_UPDATE, payload);
  }

  show(): void {
    const win = this.ensureWindow();
    this.refreshHeader();
    if (win.isVisible()) return;
    win.showInactive();
    this.options.onVisibilityChange(true);
  }

  refreshHeader(): void {
    if (
      this.window === null ||
      this.window.isDestroyed() ||
      !this.rendererReady
    ) {
      return;
    }
    this.window.webContents.send(
      CHANNEL_POPUP_HEADER_CHANGED,
      this.options.getHeaderState(),
    );
  }

  hide(): void {
    if (this.window === null || this.window.isDestroyed()) return;
    if (this.window.isVisible()) {
      this.window.hide();
      this.options.onVisibilityChange(false);
    }
  }

  move(direction: PopupMoveDirection): void {
    if (
      this.window === null ||
      this.window.isDestroyed() ||
      !this.window.isVisible()
    ) {
      return;
    }

    const bounds = this.window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const { x, y } = nextPopupPosition(bounds, workArea, direction);

    this.window.setPosition(x, y);
  }

  private post(channel: string, payload: unknown): void {
    const win = this.ensureWindow();
    if (!this.rendererReady) {
      this.pendingMessages.push({ channel, payload });
      return;
    }
    win.webContents.send(channel, payload);
  }

  sendStart(payload: AnswerStartPayload): void {
    this.show();
    this.post(CHANNEL_ANSWER_START, payload);
  }

  sendDelta(payload: AnswerDelta): void {
    this.post(CHANNEL_ANSWER_DELTA, payload);
  }

  sendDone(payload: AnswerDonePayload): void {
    this.post(CHANNEL_ANSWER_DONE, payload);
  }

  sendError(payload: AnswerError): void {
    this.post(CHANNEL_ANSWER_ERROR, payload);
  }

  destroy(): void {
    this.shuttingDown = true;
    if (this.window !== null && !this.window.isDestroyed()) {
      if (this.window.isVisible()) this.options.onVisibilityChange(false);
      this.window.removeAllListeners("close");
      this.window.destroy();
    }
    this.window = null;
    if (this.ipcInstalled) {
      ipcMain.removeListener(CHANNEL_ABORT, this.abortListener);
      ipcMain.removeListener(CHANNEL_DISMISS, this.dismissListener);
      ipcMain.removeListener(CHANNEL_POPUP_SET_PRIVACY, this.privacyListener);
      ipcMain.removeListener(CHANNEL_POPUP_SET_MODE, this.modeListener);
      ipcMain.removeListener(
        CHANNEL_POPUP_ASK_MEETING,
        this.askMeetingListener,
      );
      ipcMain.removeHandler(CHANNEL_POPUP_LOAD_HEADER);
      ipcMain.removeListener(CHANNEL_POPUP_SET_DRAFT, this.draftListener);
      this.ipcInstalled = false;
    }
  }
}
