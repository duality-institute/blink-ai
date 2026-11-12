import { app, dialog, globalShortcut, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createLocalAnswerClient } from "../backends/local-answer-client";
import { appendAnswer, readRecent } from "../core/answer-log";
import {
  AudioManager,
  type AudioCrashEvent,
  type AudioErrorEvent,
  type AudioTranscriptEvent,
} from "../core/audio-manager";
import type {
  AnswerClient,
  AnswerKind,
  AnswerPrompts,
  MeetingContext,
  VisionCapabilityResult,
} from "../core/answer-client";
import { capture, type CaptureMode } from "../core/capture";
import { MeetingContextBuffer } from "../core/meeting-context";
import { getBlinkHome, getConfigPath, saveConfig, selectBackend } from "../core/config";
import { DEFAULT_MEETING_PROMPT, DEFAULT_MONITOR_PROMPT } from "../core/prompts";
import { archiveScreenshot, savedScreenshotsDirectory } from "../core/saved-screenshots";
import {
  listTranscriptSessions,
  readTranscriptSession,
} from "../core/transcript-archive";
import { TranscriptHistory } from "../core/transcript-history";
import { MeetingTranscriptCursor } from "../core/meeting-transcript";
import { TranscriptLog } from "../core/transcript-log";
import { meetingTimeLeft, sessionLimitReached, shouldResetSession } from "../core/session-policy";
import {
  BACKEND_LABELS,
  CAPTURE_ACCELERATORS,
  CLEAR_IMAGES_ACCELERATOR,
  type BlinkBackend,
  type BlinkConfig,
} from "../core/types";
import { AnswerClientSlot, ClientReleasedError } from "./answer-client-slot";
import { AppStateStore, type AppState } from "./app-state";
import type { BlinkMode } from "./ipc";
import {
  resolveAppBundlePath,
  resolveAudioHelperPath,
} from "./meeting-listener";
import { PopupController } from "./popup";
import { PresenterNotesController } from "./presenter";
import { SettingsWindow } from "./settings";
import { WelcomeWindow } from "./welcome";
import { permissionStates } from "./permissions";
import { allGranted } from "./welcome-steps";
import { buildTray, type PermissionPane, type TrayHandle } from "./tray";

const PERMISSION_PANES: Record<PermissionPane, string> = {
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

const PRESENTER_SCROLL_SHORTCUTS = [
  ["Command+Shift+Up", "up"],
  ["Command+Shift+Down", "down"],
] as const;

const POPUP_MOVE_SHORTCUTS = [
  ["Command+Up", "up"],
  ["Command+Down", "down"],
  ["Command+Left", "left"],
  ["Command+Right", "right"],
] as const;

const MEETING_BUDGET_TICK_MS = 15_000;
const TRANSCRIPT_ASK_SHORTCUT = "CommandOrControl+Shift+Return";
const TEXT_ASK_SHORTCUT = "Control+Command+Return";
const TRANSCRIPT_PRUNE_INTERVAL_MS = 1_000;
const TRANSCRIPT_FLUSH_INTERVAL_MS = 150;


type MeetingAnswerOutcome =
  | {
      readonly kind: "done";
      readonly text: string;
      readonly durationMs: number;
      readonly reconciled: boolean;
    }
  | { readonly kind: "error"; readonly message: string };

function presenterNotesPath(): string {
  return path.join(getBlinkHome(), "presenter.md");
}

function transcriptsDirectory(): string {
  return path.join(getBlinkHome(), "transcripts");
}

function capturesRoot(): string {
  return path.join(getBlinkHome(), "captures");
}

function answerPrompts(config: BlinkConfig): AnswerPrompts {
  return {
    monitor: config.monitorPrompt.trim() === "" ? DEFAULT_MONITOR_PROMPT : config.monitorPrompt,
    meeting: config.meetingPrompt.trim() === "" ? DEFAULT_MEETING_PROMPT : config.meetingPrompt,
  };
}

function meetingAnswerTitle(context: MeetingContext): string {
  const screenshots = context.screenshotPaths.length;
  if (context.transcript !== undefined && screenshots > 0) {
    return `Meeting transcript + ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`;
  }
  if (context.transcript !== undefined) return "Meeting transcript";
  if (screenshots === 0) return "Message";
  return `${screenshots} screenshot${screenshots === 1 ? "" : "s"}`;
}

export function formatRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 120 ? message : `${message.slice(0, 117)}…`;
}

export class AppRuntime {
  readonly store: AppStateStore;
  private config: BlinkConfig;
  private tray: TrayHandle | null = null;
  private popup: PopupController | null = null;
  private presenter: PresenterNotesController | null = null;
  private lastNotifiedError: string | undefined = undefined;
  private readonly welcome = new WelcomeWindow({
    restart: () => this.restart(),
    onDismiss: () => this.popup?.show(),
  });

  private readonly settings = new SettingsWindow({
    loadPrompts: () => ({
      monitorPrompt: this.config.monitorPrompt,
      meetingPrompt: this.config.meetingPrompt,
      monitorDefault: DEFAULT_MONITOR_PROMPT,
      meetingDefault: DEFAULT_MEETING_PROMPT,
    }),
    savePrompts: (prompts) => {
      this.config = {
        ...this.config,
        monitorPrompt: prompts.monitorPrompt,
        meetingPrompt: prompts.meetingPrompt,
      };
      saveConfig(this.config);
      this.clientSlot.setPrompts(answerPrompts(this.config));
    },
    loadAnswers: () =>
      readRecent(500)
        .map((record) => ({
          timestamp: record.timestamp,
          source: record.source,
          answer: record.answer,
          durationMs: record.durationMs,
        }))
        .reverse(),
    loadTranscripts: (query) => listTranscriptSessions(transcriptsDirectory(), query),
    readTranscript: (file) =>
      readTranscriptSession(transcriptsDirectory(), file)?.markdown ?? "",
  });
  private readonly clientSlot: AnswerClientSlot;
  private audioManager: AudioManager | null = null;
  private readonly transcriptHistory = new TranscriptHistory();
  private readonly transcriptCursor = new MeetingTranscriptCursor();
  private meetingStartedAt: number | null = null;
  private lastAskAt: number | null = null;
  private sessionImageBytes = 0;
  private sessionImageCount = 0;
  private readonly meetingContext = new MeetingContextBuffer();
  private transcriptLog: TranscriptLog | null = null;
  private transcriptTimelineOriginMs: number | null = null;
  private meetingBudgetTimer: NodeJS.Timeout | null = null;
  private transcriptPruneTimer: NodeJS.Timeout | null = null;
  private transcriptFlushTimer: NodeJS.Timeout | null = null;
  private transcriptSentAtMs = 0;
  private transcriptSentPayload = "";
  private transcriptResetPending = false;
  private captureDirectory: string | null = null;
  private visionAllowed = false;
  private modeChange: Promise<void> | null = null;
  private monitorSessionActive = false;
  private meetingAsk: Promise<void> | null = null;
  private meetingAbortController: AbortController | null = null;
  private transcriptShortcutRegistered = false;
  private draftText = "";
  private shuttingDown = false;
  private registeredShortcuts: string[] = [];
  private presenterScrollShortcuts: string[] = [];
  private popupMoveShortcuts: string[] = [];
  private unsubscribePopupState: (() => void) | null = null;
  private capturing = false;

  constructor(config: BlinkConfig, startupError?: string) {
    this.config = config;
    this.clientSlot = new AnswerClientSlot(createLocalAnswerClient, answerPrompts(config));
    const initial: AppState = {
      monitoring: false,
      monitoringStarting: false,
      meeting: false,
      meetingStarting: false,
      meetingAsking: false,
      meetingScreenshotCount: 0,
      showTranscript: true,
      hideFromCapture: config.hideFromCapture,
      backend: config.backend,
    };
    if (startupError !== undefined) {
      const withError: AppState = { ...initial, lastError: startupError };
      this.store = new AppStateStore(withError);
    } else {
      this.store = new AppStateStore(initial);
    }
  }

  bootstrap(): void {
    this.popup = new PopupController({
      hideFromCapture: this.config.hideFromCapture,
      onAbort: () => {
        this.abortCurrentAnswer();
      },
      onVisibilityChange: (visible) => {
        if (visible) this.registerPopupMoveShortcuts();
        else this.releasePopupMoveShortcuts();
      },
      onPrivacyChange: (hidden) => this.setHideFromCapture(hidden),
      onModeChange: (mode) => this.setModeFromPopup(mode),
      onAskMeeting: () => {
        void this.askMeeting();
      },
      onDraftChange: (text) => { this.draftText = text; },
      onRendererReady: () => this.resendFullTranscript(),
      getHeaderState: () => {
        const {
          monitoring,
          monitoringStarting,
          meeting,
          meetingStarting,
          meetingAsking,
          meetingScreenshotCount,
          lastError,
        } = this.store.get();
        return {
          hideFromCapture: this.config.hideFromCapture,
          draftText: this.draftText,
          monitoring,
          monitoringStarting,
          meeting,
          meetingStarting,
          asking: meetingAsking,
          screenshotCount: meetingScreenshotCount,
          showTranscript: meeting,
          screenshotBytes: this.meetingContext.summary().screenshotBytes,
          imageContextBusy: this.capturing,
          ...(this.meetingStartedAt === null
            ? {}
            : { startedAt: this.meetingStartedAt }),
          ...(lastError === undefined ? {} : { lastError }),
        };
      },
    });
    this.popup.registerIpcHandlers();
    this.unsubscribePopupState = this.store.subscribe(
      ({
        monitoring,
        monitoringStarting,
        meeting,
        meetingStarting,
        meetingAsking,
        meetingScreenshotCount,
        lastError,
      }) => {
        if (lastError !== this.lastNotifiedError) {
          this.lastNotifiedError = lastError;
          this.popup?.refreshHeader();
        }
        this.popup?.sendMonitoringChange({ monitoring, monitoringStarting });
        this.popup?.setTranscriptColumn(meeting);
        this.popup?.sendMeetingChange({
          meeting,
          meetingStarting,
          asking: meetingAsking,
          showTranscript: meeting,
          screenshotBytes: this.meetingContext.summary().screenshotBytes,
          imageContextBusy: this.capturing,
          screenshotCount: meetingScreenshotCount,
          ...(this.meetingStartedAt === null
            ? {}
            : { startedAt: this.meetingStartedAt }),
        });
      },
    );
    this.presenter = new PresenterNotesController({
      filePath: presenterNotesPath(),
      hideFromCapture: this.config.hideFromCapture,
      onPrivacyChange: (hidden) => this.setHideFromCapture(hidden),
      onVisibilityChange: (visible) => {
        if (visible) this.registerPresenterScrollShortcuts();
        else this.releasePresenterScrollShortcuts();
      },
    });
    this.presenter.registerIpcHandlers();
    this.tray = buildTray({
      store: this.store,
      assetsDir: path.join(app.getAppPath(), "assets", "tray"),
      callbacks: {
        onShowPopup: () => this.popup?.show(),
        onShowPresenter: () => this.showPresenter(),
        onOpenPermission: (pane) => this.openPermissionSettings(pane),
        onOpenWelcome: () => this.welcome.show(),
        onRevealBundle: () => this.revealBundle(),
        onShowSavedScreenshots: () => this.showSavedScreenshots(),
        onOpenConfig: () => this.openConfig(),
        onOpenAnswerLog: () => this.openAnswerLog(),
        onOpenTranscripts: () => this.settings.show("transcripts"),
        onBackendChange: (backend) => this.changeBackend(backend),
        onQuit: () => app.quit(),
      },
    });
    this.registerTranscriptShortcut();
    if (allGranted(permissionStates())) this.popup.show();
    else this.welcome.show();
  }

  private restart(): void {
    const bundle = resolveAppBundlePath(app.getAppPath());
    if (!fs.existsSync(bundle)) {
      this.store.update({ lastError: `Blink.app is missing at ${bundle}` });
      return;
    }
    app.relaunch({
      execPath: "/usr/bin/open",
      args: ["-n", "-a", bundle, "--args", app.getAppPath(), process.execPath],
    });
    app.quit();
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  showPopup(): void {
    this.popup?.show();
  }

  setMode(mode: BlinkMode): Promise<void> {
    if (this.modeChange !== null) return this.modeChange;
    this.store.update({ lastError: null });
    const change = this.performModeChange(mode).finally(() => {
      if (this.modeChange === change) this.modeChange = null;
    });
    this.modeChange = change;
    return change;
  }

  currentMode(): BlinkMode {
    const state = this.store.get();
    if (state.meeting || state.meetingStarting) return "meeting";
    if (state.monitoring || state.monitoringStarting) return "monitor";
    return "off";
  }

  private async performModeChange(mode: BlinkMode): Promise<void> {
    if (this.currentMode() === mode) return;
    const state = this.store.get();
    if (state.meeting || state.meetingStarting || this.audioManager !== null) {
      await this.stopMeeting();
    }
    if (this.store.get().monitoring || this.store.get().monitoringStarting) {
      await this.stopMonitoring();
    }
    switch (mode) {
      case "monitor":
        await this.startMonitoring();
        return;
      case "meeting":
        await this.startMeeting();
        return;
      case "off":
        return;
    }
  }

  askMeeting(): Promise<void> {
    if (this.meetingAsk !== null) return this.meetingAsk;
    const request = this.performMeetingAsk().finally(() => {
      if (this.meetingAsk === request) this.meetingAsk = null;
    });
    this.meetingAsk = request;
    return request;
  }

  private setModeFromPopup(mode: BlinkMode): void {
    void this.setMode(mode).catch((error: unknown) => {
      this.store.update({ lastError: formatRuntimeError(error) });
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.unsubscribePopupState?.();
    this.unsubscribePopupState = null;
    this.releaseCaptureShortcut();
    this.releaseTranscriptShortcut();
    this.releasePresenterScrollShortcuts();
    this.releasePopupMoveShortcuts();
    this.meetingAbortController?.abort();
    await this.stopMeeting();
    if (this.monitorSessionActive) {
      this.monitorSessionActive = false;
      await this.endRemoteSession("monitor");
    }
    await this.clearCaptureContext();
    this.popup?.destroy();
    this.popup = null;
    this.presenter?.destroy();
    this.presenter = null;
    await this.releaseClient();
    this.tray?.dispose();
    this.tray = null;
    this.store.update({
      monitoring: false,
      monitoringStarting: false,
      meeting: false,
      meetingStarting: false,
      meetingAsking: false,
      meetingScreenshotCount: 0,
    });
  }

  private async startMonitoring(): Promise<void> {
    if (this.store.get().monitoringStarting) return;

    this.store.update({ monitoringStarting: true });
    try {
      const vision = await this.ensureVisionCapability();
      if (!vision.ok) {
        this.store.update({
          monitoringStarting: false,
          monitoring: false,
          lastError: vision.reason,
        });
        console.error(
          `[blink] ${vision.reason}. Run blink-ai configure or edit ${getConfigPath()}.`,
        );
        return;
      }
      await this.ensureCaptureContext();
      const client = await this.ensureClient();
      await client.resetSession("monitor");
      this.monitorSessionActive = true;
      this.lastAskAt = null;
      this.sessionImageBytes = 0;
      this.sessionImageCount = 0;
      this.registerCaptureShortcut();
      this.store.update({ monitoringStarting: false, monitoring: true });
    } catch (error) {
      this.monitorSessionActive = false;
      await this.releaseCaptureContextIfIdle();
      this.store.update({
        monitoringStarting: false,
        monitoring: false,
        lastError: formatRuntimeError(error),
      });
    }
  }

  private async stopMonitoring(): Promise<void> {
    const hadSession = this.monitorSessionActive;
    this.monitorSessionActive = false;
    this.lastAskAt = null;
    this.sessionImageBytes = 0;
    this.sessionImageCount = 0;
    this.meetingAbortController?.abort();
    if (this.meetingAsk !== null) await this.meetingAsk;
    this.store.update({ monitoring: false, monitoringStarting: false });
    if (!this.store.get().meeting) {
      this.releaseCaptureShortcut();
      await this.clearCaptureContext();
    }
    if (hadSession) await this.endRemoteSession("monitor");
  }

  private async ensureVisionCapability(): Promise<VisionCapabilityResult> {
    if (this.visionAllowed) return { ok: true };
    const client = await this.ensureClient();
    let vision: VisionCapabilityResult;
    try {
      vision = await client.checkVisionCapability();
    } catch (error) {
      return {
        ok: false,
        reason: `Vision capability check failed: ${formatRuntimeError(error)}`,
      };
    }
    if (vision.ok) this.visionAllowed = true;
    return vision;
  }

  private async startMeeting(): Promise<void> {
    const binary = resolveAudioHelperPath(app.getAppPath());
    if (!fs.existsSync(binary)) {
      this.store.update({
        meeting: false,
        meetingStarting: false,
        lastError: "Meeting audio helper is missing; run bun run build:audio",
      });
      return;
    }

    this.clearTranscriptState();
    this.meetingStartedAt = Date.now();
    this.store.update({
      meetingStartedAt: this.meetingStartedAt,
      meeting: false,
      meetingStarting: true,
      lastError: null,
    });

    try {
      await this.ensureCaptureContext();
      const client = await this.ensureClient();
      await client.resetSession("meeting");
    } catch (error) {
      await this.releaseCaptureContextIfIdle();
      this.store.update({
        meeting: false,
        meetingStarting: false,
        lastError: formatRuntimeError(error),
      });
      return;
    }

    if (this.shuttingDown) {
      await this.releaseCaptureContextIfIdle();
      return;
    }

    const manager = new AudioManager({ binary });
    this.audioManager = manager;
    let startupComplete = false;

    manager.on("transcript", (event: AudioTranscriptEvent) => {
      if (this.audioManager !== manager || this.shuttingDown) return;
      this.alignTranscriptTimeline(event.endMs);
      this.transcriptHistory.push(event);
      this.syncMeetingContextState();
      this.appendToTranscriptLog(event);
      this.scheduleTranscriptFlush();
    });
    manager.on("ready", () => {
      if (
        !startupComplete ||
        this.audioManager !== manager ||
        this.shuttingDown
      ) {
        return;
      }
      this.alignTranscriptTimeline();
      this.store.update({
        meeting: true,
        meetingStarting: false,
        lastError: null,
      });
    });
    manager.on("crash", (event: AudioCrashEvent) => {
      if (this.audioManager !== manager || this.shuttingDown) return;
      this.clearTranscriptState();
      const reason = event.signal ?? event.code ?? "unknown exit";
      this.store.update({
        lastError: `Meeting listener interrupted (${reason}); retrying`,
      });
    });
    manager.on("fatal", (event: AudioErrorEvent) => {
      if (this.audioManager !== manager) return;
      void this.failMeeting(manager, event.message);
    });

    try {
      await manager.start();
      startupComplete = true;
      if (this.audioManager !== manager || this.shuttingDown) {
        await manager.stop();
        return;
      }
      if (!manager.isRunning()) return;
      this.alignTranscriptTimeline();
      this.registerCaptureShortcut();
      this.startMeetingBudgetTimer();
      this.store.update({
        meeting: true,
        meetingStarting: false,
        lastError: null,
      });
    } catch (error) {
      startupComplete = true;
      if (this.audioManager !== manager) return;
      this.audioManager = null;
      manager.removeAllListeners();
      await manager.stop();
      this.clearTranscriptState();
      await this.releaseCaptureContextIfIdle();
      this.store.update({
        meeting: false,
        meetingStarting: false,
        lastError: formatRuntimeError(error),
      });
    }
  }

  private async failMeeting(
    manager: AudioManager,
    message: string,
  ): Promise<void> {
    if (this.audioManager !== manager) return;
    this.audioManager = null;
    this.meetingStartedAt = null;
    this.store.update({ meetingStartedAt: null });
    this.meetingAbortController?.abort();
    if (this.meetingAsk !== null) await this.meetingAsk;
    this.clearTranscriptState();
    await this.releaseCaptureContextIfIdle();
    manager.removeAllListeners();
    await manager.stop();
    if (!this.store.get().monitoring) this.releaseCaptureShortcut();
    await this.endRemoteSession("meeting");
    if (this.shuttingDown) return;
    this.store.update({
      meeting: false,
      meetingStarting: false,
      meetingAsking: false,
      lastError: formatRuntimeError(message),
    });
  }

  /**
   * Polled rather than scheduled with one long timer: a laptop that sleeps
   * through the deadline must still stop on wake.
   */
  private startMeetingBudgetTimer(): void {
    this.stopMeetingBudgetTimer();
    const timer = setInterval(() => {
      const startedAt = this.meetingStartedAt;
      if (startedAt === null || !this.store.get().meeting) return;
      if (!meetingTimeLeft(startedAt, Date.now()).expired) return;
      this.stopMeetingBudgetTimer();
      void this.setMode("off").then(() => {
        this.store.update({
          lastError: "Meeting reached its 3 hour limit and was stopped",
        });
      });
    }, MEETING_BUDGET_TICK_MS);
    timer.unref?.();
    this.meetingBudgetTimer = timer;
  }

  private stopMeetingBudgetTimer(): void {
    if (this.meetingBudgetTimer === null) return;
    clearInterval(this.meetingBudgetTimer);
    this.meetingBudgetTimer = null;
  }

  private async stopMeeting(): Promise<void> {
    this.stopMeetingBudgetTimer();
    const manager = this.audioManager;
    this.audioManager = null;
    this.meetingStartedAt = null;
    this.store.update({ meetingStartedAt: null });
    this.meetingAbortController?.abort();
    if (this.meetingAsk !== null) await this.meetingAsk;
    this.clearTranscriptState();
    await this.releaseCaptureContextIfIdle();
    const hadRemoteMeeting = this.store.get().meeting || this.store.get().meetingStarting;
    this.store.update({
      meeting: false,
      meetingStarting: false,
      meetingAsking: false,
    });
    if (!this.store.get().monitoring) this.releaseCaptureShortcut();
    if (manager !== null) {
      manager.removeAllListeners();
      await manager.stop();
    }
    if (hadRemoteMeeting) await this.endRemoteSession("meeting");
  }

  private async endRemoteSession(kind: AnswerKind): Promise<void> {
    const client = this.clientSlot.current();
    if (client === null) return;
    try {
      await client.endSession(kind);
    } catch (error) {
      console.error(
        `[blink] could not end remote ${kind} session: ${formatRuntimeError(error)}`,
      );
    }
  }

  private alignTranscriptTimeline(streamPositionMs = 0): void {
    if (this.transcriptTimelineOriginMs !== null) return;
    this.transcriptTimelineOriginMs =
      performance.now() - Math.max(0, streamPositionMs);
    this.transcriptPruneTimer = setInterval(() => {
      this.flushTranscriptLines();
    }, TRANSCRIPT_PRUNE_INTERVAL_MS);
    this.transcriptPruneTimer.unref();
  }

  /**
   * Skips the store write when nothing changed: speech arrives several times a
   * second and every update rebuilds the tray menu.
   */
  private sessionExpired(mode: AnswerKind): boolean {
    return shouldResetSession({
      mode,
      lastAskAt: this.lastAskAt,
      now: Date.now(),
    });
  }

  private sessionFull(): boolean {
    return sessionLimitReached({
      images: this.sessionImageCount,
      bytes: this.sessionImageBytes,
    });
  }

  private syncMeetingContextState(): void {
    const { screenshotCount } = this.meetingContext.summary();
    if (this.store.get().meetingScreenshotCount === screenshotCount) return;
    this.store.update({ meetingScreenshotCount: screenshotCount });
  }

  private async ensureCaptureContext(): Promise<void> {
    if (this.captureDirectory !== null) return;
    const root = capturesRoot();
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(root, 0o700);
    const directory = path.join(root, randomUUID());
    await fs.promises.mkdir(directory, { mode: 0o700 });
    this.captureDirectory = directory;
  }

  private async releaseCaptureContextIfIdle(): Promise<void> {
    if (this.store.get().monitoring) return;
    await this.clearCaptureContext();
  }

  private async clearCaptureContext(): Promise<void> {
    const directory = this.captureDirectory;
    this.captureDirectory = null;
    this.meetingContext.clear();
    this.syncMeetingContextState();
    if (directory === null) return;
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (!this.shuttingDown) {
        this.store.update({
          lastError: `Could not clear staged captures: ${formatRuntimeError(error)}`,
        });
      }
    }
  }

  private async removeSubmittedScreenshots(
    screenshotPaths: readonly string[],
  ): Promise<void> {
    this.meetingContext.removeScreenshots(screenshotPaths);
    this.syncMeetingContextState();
    const results = await Promise.allSettled(
      screenshotPaths.map((screenshotPath) =>
        fs.promises.rm(screenshotPath, { force: true }),
      ),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined && !this.shuttingDown) {
      this.store.update({
        lastError: `Could not remove a submitted Meeting capture: ${formatRuntimeError(failed.reason)}`,
      });
    }
  }

  private appendToTranscriptLog(event: AudioTranscriptEvent): void {
    try {
      this.transcriptLog ??= new TranscriptLog(transcriptsDirectory());
      this.transcriptLog.append(event);
    } catch (error) {
      this.transcriptLog = null;
      this.store.update({
        lastError: `Could not save transcript: ${formatRuntimeError(error)}`,
      });
    }
  }

  private clearTranscriptState(): void {
    this.transcriptLog = null;
    if (this.transcriptPruneTimer !== null) {
      clearInterval(this.transcriptPruneTimer);
      this.transcriptPruneTimer = null;
    }
    if (this.transcriptFlushTimer !== null) {
      clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = null;
    }
    this.transcriptTimelineOriginMs = null;
    this.transcriptHistory.clear();
    this.transcriptCursor.reset();
    this.lastAskAt = null;
    this.sessionImageBytes = 0;
    this.sessionImageCount = 0;
    this.transcriptResetPending = true;
    this.flushTranscriptLines();
  }

  private scheduleTranscriptFlush(): void {
    if (this.transcriptFlushTimer !== null) return;
    const elapsedMs = performance.now() - this.transcriptSentAtMs;
    const waitMs = Math.max(0, TRANSCRIPT_FLUSH_INTERVAL_MS - elapsedMs);
    this.transcriptFlushTimer = setTimeout(() => {
      this.transcriptFlushTimer = null;
      this.flushTranscriptLines();
    }, waitMs);
    this.transcriptFlushTimer.unref();
  }

  /**
   * Leaves the history undrained until the renderer can receive it, so speech
   * recognized before the popup finishes loading still appears once it does.
   */
  private flushTranscriptLines(): void {
    if (this.popup === null || !this.popup.rendererLoaded) return;

    const { changed, volatile } = this.transcriptHistory.drain();
    const serializedVolatile = JSON.stringify(volatile);
    const reset = this.transcriptResetPending;
    if (
      !reset &&
      changed.length === 0 &&
      serializedVolatile === this.transcriptSentPayload
    ) {
      return;
    }

    this.transcriptResetPending = false;
    this.transcriptSentPayload = serializedVolatile;
    this.transcriptSentAtMs = performance.now();
    this.popup.sendTranscript({
      changed: [...changed],
      volatile: [...volatile],
      reset,
    });
  }

  private resendFullTranscript(): void {
    if (this.popup === null || !this.popup.rendererLoaded) return;
    const { volatile } = this.transcriptHistory.drain();
    this.transcriptResetPending = false;
    this.transcriptSentPayload = JSON.stringify(volatile);
    this.transcriptSentAtMs = performance.now();
    this.popup.sendTranscript({
      changed: [...this.transcriptHistory.lines()],
      volatile: [...volatile],
      reset: true,
    });
  }

  private registerTranscriptShortcut(): void {
    if (this.transcriptShortcutRegistered) return;
    this.transcriptShortcutRegistered = true;
    for (const shortcut of [TRANSCRIPT_ASK_SHORTCUT, TEXT_ASK_SHORTCUT]) {
      const registered = globalShortcut.register(shortcut, () => {
        void this.askMeeting();
      });
      if (!registered) this.store.update({ lastError: `Answer hotkey taken: ${shortcut}` });
    }
  }

  private releaseTranscriptShortcut(): void {
    if (!this.transcriptShortcutRegistered) return;
    globalShortcut.unregister(TRANSCRIPT_ASK_SHORTCUT);
    globalShortcut.unregister(TEXT_ASK_SHORTCUT);
    this.transcriptShortcutRegistered = false;
  }

  private async performMeetingAsk(): Promise<void> {
    if (this.capturing) {
      this.showMeetingError("Wait for the image operation to finish before asking");
      return;
    }
    const meeting = this.store.get().meeting;
    if (!meeting && !this.store.get().monitoring) {
      this.showMeetingError("Turn on Monitor or Meeting before asking");
      return;
    }
    const screenshotPaths = this.meetingContext.staged();
    const submittedText = this.draftText;
    const message = submittedText.trim();
    if (!meeting && screenshotPaths.length === 0 && message === "") {
      this.showMeetingError("Type a message or capture a screenshot before asking");
      return;
    }
    let chunk = this.transcriptCursor.chunk(
      this.transcriptHistory.lines(),
      this.transcriptHistory.volatileLines(),
    );

    const abortController = new AbortController();
    this.meetingAbortController = abortController;
    this.store.update({ meetingAsking: true, lastError: null });
    try {
      if (abortController.signal.aborted || this.shuttingDown) return;

      const client = await this.ensureClient();
      const askImageBytes = this.meetingContext.summary().screenshotBytes;
      // A full session is renewed after the answer that filled it; this retries a failed renewal.
      if (this.sessionExpired(meeting ? "meeting" : "monitor") || this.sessionFull()) {
        await client.resetSession(meeting ? "meeting" : "monitor");
        this.sessionImageBytes = 0;
        this.sessionImageCount = 0;
        if (meeting) {
          this.transcriptCursor.reset();
          chunk = this.transcriptCursor.chunk(
            this.transcriptHistory.lines(),
            this.transcriptHistory.volatileLines(),
          );
        }
      }
      const context: MeetingContext = {
        ...(meeting ? { transcript: chunk.text } : {}),
        ...(message === "" ? {} : { message }),
        screenshotPaths: [...screenshotPaths],
      };
      const prompt = answerPrompts(this.config)[meeting ? "meeting" : "monitor"];
      this.meetingContext.assertWithinLimits(
        Buffer.byteLength(prompt + (context.transcript ?? "") + message, "utf8"),
      );
      const detectedAt = new Date().toISOString();
      this.popup?.sendStart({
        source: meeting ? "meeting" : "monitor",
        title: meetingAnswerTitle(context),
        detectedAt,
      });
      let outcome: MeetingAnswerOutcome | undefined;
      const callbacks = {
        signal: abortController.signal,
        onDelta: (text: string) => {
          this.popup?.sendDelta({ type: "delta", text });
        },
        onDone: (
          text: string,
          durationMs: number,
          metadata: { readonly reconciled: boolean },
        ) => {
          outcome ??= {
            kind: "done",
            text,
            durationMs,
            reconciled: metadata.reconciled,
          };
        },
        onError: (message: string) => {
          outcome ??= { kind: "error", message };
        },
      };
      await (meeting
        ? client.answerMeeting(context, callbacks)
        : client.answerMonitor(context.screenshotPaths, callbacks, message));

      if (abortController.signal.aborted) {
        this.popup?.sendDone({
          type: "complete",
          text: "",
          reconciled: false,
          durationMs: 0,
          cancelled: true,
        });
        return;
      }
      if (outcome === undefined) {
        this.showMeetingError("Answer ended without a completion event");
        return;
      }
      if (outcome.kind === "error") {
        this.showMeetingError(outcome.message);
        return;
      }

      appendAnswer({
        timestamp: detectedAt,
        source: meeting ? "meeting" : "monitor",
        screenshotPaths: context.screenshotPaths,
        answer: outcome.text,
        durationMs: outcome.durationMs,
      });
      if (meeting) this.transcriptCursor.markSubmitted(chunk.lineIds);
      this.lastAskAt = Date.now();
      this.sessionImageBytes += askImageBytes;
      this.sessionImageCount += context.screenshotPaths.length;
      const renewSession = this.sessionFull();
      await this.removeSubmittedScreenshots(context.screenshotPaths);
      if (this.draftText === submittedText) this.draftText = "";
      this.popup?.sendDone({
        type: "complete",
        text: outcome.text,
        reconciled: outcome.reconciled,
        durationMs: outcome.durationMs,
        cancelled: false,
        sessionRenewed: renewSession,
        submittedText,
      });
      if (renewSession && !abortController.signal.aborted && !this.shuttingDown) {
        try {
          await client.resetSession(meeting ? "meeting" : "monitor");
          if (meeting) this.transcriptCursor.reset();
          this.sessionImageBytes = 0;
          this.sessionImageCount = 0;
          this.lastAskAt = null;
        } catch (error) {
          console.error(
            `[blink] session renewal failed; the next Ask retries: ${formatRuntimeError(error)}`,
          );
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted && !this.shuttingDown) {
        this.showMeetingError(formatRuntimeError(error));
      }
    } finally {
      if (this.meetingAbortController === abortController) {
        this.meetingAbortController = null;
      }
      this.store.update({ meetingAsking: false });
    }
  }

  private abortCurrentAnswer(): void {
    this.meetingAbortController?.abort();
  }

  private showMeetingError(message: string): void {
    this.store.update({ lastError: message });
    this.popup?.show();
    this.popup?.sendError({ type: "error", message });
  }

  private showPresenter(): void {
    this.presenter?.show();
  }

  private setHideFromCapture(hidden: boolean): void {
    this.config.hideFromCapture = hidden;
    saveConfig(this.config);
    this.popup?.setHiddenFromCapture(hidden);
    this.presenter?.setHiddenFromCapture(hidden);
    this.store.update({ hideFromCapture: hidden });
  }

  private async showSavedScreenshots(): Promise<void> {
    const directory = savedScreenshotsDirectory();
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(directory);
    if (error !== "") throw new Error(error);
  }

  private registerPresenterScrollShortcuts(): void {
    if (this.presenterScrollShortcuts.length > 0) return;
    const taken: string[] = [];
    for (const [accelerator, direction] of PRESENTER_SCROLL_SHORTCUTS) {
      const registered = globalShortcut.register(accelerator, () => {
        this.presenter?.scroll(direction);
      });
      if (registered) this.presenterScrollShortcuts.push(accelerator);
      else taken.push(accelerator);
    }
    if (taken.length > 0) {
      this.store.update({
        lastError: `Presenter scroll hotkey taken: ${taken.join(", ")}`,
      });
    }
  }

  private releasePresenterScrollShortcuts(): void {
    for (const accelerator of this.presenterScrollShortcuts) {
      globalShortcut.unregister(accelerator);
    }
    this.presenterScrollShortcuts = [];
  }

  private registerPopupMoveShortcuts(): void {
    if (this.popupMoveShortcuts.length > 0) return;
    const taken: string[] = [];
    for (const [accelerator, direction] of POPUP_MOVE_SHORTCUTS) {
      const registered = globalShortcut.register(accelerator, () => {
        this.popup?.move(direction);
      });
      if (registered) this.popupMoveShortcuts.push(accelerator);
      else taken.push(accelerator);
    }
    if (taken.length > 0) {
      this.store.update({
        lastError: `Popup movement hotkey taken: ${taken.join(", ")}`,
      });
    }
  }

  private releasePopupMoveShortcuts(): void {
    for (const accelerator of this.popupMoveShortcuts) {
      globalShortcut.unregister(accelerator);
    }
    this.popupMoveShortcuts = [];
  }

  private registerCaptureShortcut(): void {
    if (this.registeredShortcuts.length > 0) return;
    const taken: string[] = [];
    for (const [accelerator, mode] of [
      [CAPTURE_ACCELERATORS.region, "region"],
      [CAPTURE_ACCELERATORS.screen, "screen"],
    ] as const) {
      const registered = globalShortcut.register(accelerator, () => {
        void this.runCapture(mode);
      });
      if (registered) this.registeredShortcuts.push(accelerator);
      else taken.push(accelerator);
    }
    if (globalShortcut.register(CLEAR_IMAGES_ACCELERATOR, () => { void this.clearImages(); })) {
      this.registeredShortcuts.push(CLEAR_IMAGES_ACCELERATOR);
    } else {
      taken.push(CLEAR_IMAGES_ACCELERATOR);
    }
    if (taken.length > 0) {
      this.store.update({
        lastError: `Capture hotkey taken by another app: ${taken.join(", ")}`,
      });
    }
  }

  private releaseCaptureShortcut(): void {
    if (this.registeredShortcuts.length === 0) return;
    for (const accelerator of this.registeredShortcuts) {
      globalShortcut.unregister(accelerator);
    }
    this.registeredShortcuts = [];
  }

  private async runCapture(mode: CaptureMode): Promise<void> {
    const state = this.store.get();
    if (!state.monitoring && !state.meeting) return;
    const directory = this.captureDirectory;
    if (directory === null || this.capturing) return;
    this.capturing = true;
    this.popup?.refreshHeader();
    try {
      this.meetingContext.assertCanStage(0, this.captureTextBytes());
      const result = await capture(directory, mode);
      if (result.status === "failed") {
        this.store.update({ lastError: `Capture failed: ${result.message}` });
        return;
      }
      if (result.status !== "captured") return;
      const current = this.store.get();
      if (
        (current.monitoring || current.meeting) &&
        this.captureDirectory === directory
      ) {
        try {
          const { size } = await fs.promises.stat(result.path);
          const latest = this.store.get();
          if (this.captureDirectory !== directory || (!latest.monitoring && !latest.meeting)) {
            await fs.promises.rm(result.path, { force: true });
            return;
          }
          this.meetingContext.stageScreenshot(result.path, size, this.captureTextBytes());
        } catch (error) {
          await fs.promises.rm(result.path, { force: true });
          throw error;
        }
        this.syncMeetingContextState();
        try {
          await archiveScreenshot(result.path);
        } catch (error) {
          this.store.update({ lastError: `Could not save screenshot: ${formatRuntimeError(error)}` });
          return;
        }
        this.store.update({ lastError: null });
      } else {
        await fs.promises.rm(result.path, { force: true });
      }
    } catch (error) {
      this.store.update({ lastError: formatRuntimeError(error) });
      this.popup?.show();
    } finally {
      this.capturing = false;
      this.popup?.refreshHeader();
    }
  }

  private captureTextBytes(): number {
    const meeting = this.store.get().meeting;
    const transcript = meeting
      ? this.transcriptCursor.chunk(this.transcriptHistory.lines(), this.transcriptHistory.volatileLines()).text
      : "";
    const prompt = answerPrompts(this.config)[meeting ? "meeting" : "monitor"];
    return Buffer.byteLength(transcript + prompt + this.draftText, "utf8");
  }

  private async clearImages(): Promise<void> {
    if (this.capturing || this.store.get().meetingAsking) return;
    this.capturing = true;
    this.popup?.refreshHeader();
    this.store.update({ lastError: null });
    try {
      await this.removeSubmittedScreenshots(this.meetingContext.staged());
    } finally {
      this.capturing = false;
      this.popup?.refreshHeader();
    }
  }

  private ensureClient(): Promise<AnswerClient> {
    if (this.shuttingDown) {
      return Promise.reject(new ClientReleasedError("Blink is shutting down"));
    }
    return this.clientSlot.acquire(this.config);
  }

  private async releaseClient(): Promise<void> {
    try {
      await this.clientSlot.release();
    } catch (error) {
      console.error(
        `[blink] could not stop ${BACKEND_LABELS[this.config.backend]}: ${formatRuntimeError(error)}`,
      );
    }
  }

  /**
   * Runs as the pending mode change, so Monitor and Meeting cannot start
   * against the outgoing backend while it is being replaced.
   */
  private async changeBackend(backend: BlinkBackend): Promise<void> {
    while (this.modeChange !== null) await Promise.allSettled([this.modeChange]);
    if (this.shuttingDown || backend === this.config.backend) return;
    const change = this.performBackendChange(backend).finally(() => {
      if (this.modeChange === change) this.modeChange = null;
    });
    this.modeChange = change;
    await change;
  }

  private async performBackendChange(backend: BlinkBackend): Promise<void> {
    this.store.update({ lastError: null });
    await this.performModeChange("off");
    this.meetingAbortController?.abort();
    if (this.meetingAsk !== null) await this.meetingAsk;
    await this.releaseClient();
    this.visionAllowed = false;
    const next = selectBackend(this.config, backend);
    saveConfig(next);
    this.config = next;
    this.store.update({ backend: next.backend });
  }

  private openConfig(): void {
    this.settings.show("prompts");
  }

  private openAnswerLog(): void {
    this.settings.show("answers");
  }

  private async openPermissionSettings(pane: PermissionPane): Promise<void> {
    const detail =
      pane === "microphone"
        ? "Blink needs Microphone access to transcribe your own voice during a Meeting."
        : "Blink needs Screen & System Audio Recording to capture screenshots and meeting audio.";
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Cancel", "Open System Settings"],
      defaultId: 1,
      cancelId: 0,
      message:
        pane === "microphone"
          ? "Open Microphone settings?"
          : "Open Screen & System Audio Recording settings?",
      detail: `${detail}\n\nGrant it to Blink in System Settings, then restart Blink so macOS applies the change.`,
    });
    if (response !== 1) return;
    await shell.openExternal(PERMISSION_PANES[pane]);
  }

  private revealBundle(): void {
    const bundle = resolveAppBundlePath(app.getAppPath());
    if (!fs.existsSync(bundle)) {
      this.store.update({ lastError: `Blink.app is missing at ${bundle}` });
      return;
    }
    shell.showItemInFolder(bundle);
  }

}
