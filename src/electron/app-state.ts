/**
 * AppState: the tiny observable state store shared by the tray and popup.
 * Deliberately runtime-agnostic; it has no Electron imports.
 *
 * `exactOptionalPropertyTypes: true` forbids assigning `undefined` to an
 * optional key, so patch semantics use `null` to explicitly clear an optional
 * field. See {@link AppStateStore.update}.
 */

import type { BlinkBackend } from "../core/types";

export interface AppState {
  readonly monitoring: boolean;
  readonly monitoringStarting: boolean;
  readonly meeting: boolean;
  readonly meetingStarting: boolean;
  readonly meetingAsking: boolean;
  readonly meetingScreenshotCount: number;
  readonly showTranscript: boolean;
  readonly meetingStartedAt?: number;
  readonly hideFromCapture: boolean;
  readonly backend: BlinkBackend;
  readonly lastError?: string;
}

export interface AppStatePatch {
  monitoring?: boolean;
  monitoringStarting?: boolean;
  meeting?: boolean;
  meetingStarting?: boolean;
  meetingAsking?: boolean;
  meetingScreenshotCount?: number;
  showTranscript?: boolean;
  meetingStartedAt?: number | null;
  hideFromCapture?: boolean;
  backend?: BlinkBackend;
  lastError?: string | null;
}

export type AppStateListener = (state: AppState) => void;

/**
 * How long an error stays on screen. Errors used to persist until some other
 * code happened to clear them, which left the tray stuck on the error icon for
 * the rest of the session; expiring them centrally means every error path
 * recovers on its own.
 */
export const ERROR_VISIBLE_MS = 9_000;

export class AppStateStore {
  private state: AppState;
  private readonly listeners = new Set<AppStateListener>();
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    initial: AppState,
    private readonly errorVisibleMs: number = ERROR_VISIBLE_MS,
  ) {
    this.state = { ...initial };
  }

  private scheduleErrorClear(): void {
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = null;
    if (this.state.lastError === undefined || this.errorVisibleMs <= 0) return;
    const timer = setTimeout(() => {
      this.errorTimer = null;
      if (this.state.lastError !== undefined) this.update({ lastError: null });
    }, this.errorVisibleMs);
    timer.unref?.();
    this.errorTimer = timer;
  }

  get(): AppState {
    return { ...this.state };
  }

  update(patch: AppStatePatch): void {
    const next: {
      monitoring: boolean;
      monitoringStarting: boolean;
      meeting: boolean;
      meetingStarting: boolean;
      meetingAsking: boolean;
      meetingScreenshotCount: number;
      showTranscript: boolean;
      meetingStartedAt?: number;
      hideFromCapture: boolean;
      backend: BlinkBackend;
      lastError?: string;
    } = {
      monitoring: this.state.monitoring,
      monitoringStarting: this.state.monitoringStarting,
      meeting: this.state.meeting,
      meetingStarting: this.state.meetingStarting,
      meetingAsking: this.state.meetingAsking,
      meetingScreenshotCount: this.state.meetingScreenshotCount,
      showTranscript: this.state.showTranscript,
      hideFromCapture: this.state.hideFromCapture,
      backend: this.state.backend,
    };
    if (this.state.lastError !== undefined) next.lastError = this.state.lastError;

    if (patch.meeting !== undefined) next.meeting = patch.meeting;
    if (patch.meetingStarting !== undefined) {
      next.meetingStarting = patch.meetingStarting;
    }
    if (patch.meetingAsking !== undefined) {
      next.meetingAsking = patch.meetingAsking;
    }
    if (patch.meetingScreenshotCount !== undefined) {
      next.meetingScreenshotCount = patch.meetingScreenshotCount;
    }
    if (patch.monitoring !== undefined) next.monitoring = patch.monitoring;
    if (patch.monitoringStarting !== undefined) {
      next.monitoringStarting = patch.monitoringStarting;
    }
    if (patch.showTranscript !== undefined) {
      next.showTranscript = patch.showTranscript;
    }
    if (patch.meetingStartedAt !== undefined) {
      if (patch.meetingStartedAt === null) delete next.meetingStartedAt;
      else next.meetingStartedAt = patch.meetingStartedAt;
    }
    if (patch.hideFromCapture !== undefined) {
      next.hideFromCapture = patch.hideFromCapture;
    }
    if (patch.backend !== undefined) next.backend = patch.backend;
    if (patch.lastError !== undefined) {
      if (patch.lastError === null) delete next.lastError;
      else next.lastError = patch.lastError;
    }

    const errorChanged = this.state.lastError !== next.lastError;
    this.state = next;
    if (errorChanged) this.scheduleErrorClear();
    const snapshot = this.get();
    for (const l of this.listeners) l(snapshot);
  }

  subscribe(listener: AppStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
