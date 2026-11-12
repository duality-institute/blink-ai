/**
 * Renders the macOS tray from an {@link AppStateStore}, updating its icon,
 * tooltip, and menu on every state change.
 *
 * Icons are template PNGs under `assets/tray/` — monochrome black on
 * transparent, `-Template` suffix so macOS auto-inverts on dark menu bars.
 * `nativeImage.createFromPath("iconTemplate.png")` automatically picks up the
 * `@2x.png` sibling for Retina displays; we still call `setTemplateImage(true)`
 * explicitly because the suffix alone is a filesystem convention, not a
 * runtime flag.
 *
 * Tray never touches the server, watcher, or config directly; the runtime
 * supplies callbacks for those operations.
 */

import { Tray, Menu, nativeImage } from "electron";
import type { NativeImage, MenuItemConstructorOptions } from "electron";
import * as path from "node:path";
import type { BlinkBackend } from "../core/types";
import type { AppState, AppStateStore } from "./app-state";
import { backendMenu } from "./backend-menu";

export type PermissionPane = "microphone" | "screen";

interface TrayCallbacks {
  onShowPopup: () => void | Promise<void>;
  onShowPresenter: () => void | Promise<void>;
  onOpenPermission: (pane: PermissionPane) => void | Promise<void>;
  onOpenWelcome: () => void | Promise<void>;
  onRevealBundle: () => void | Promise<void>;
  onShowSavedScreenshots: () => void | Promise<void>;
  onOpenConfig: () => void | Promise<void>;
  onOpenAnswerLog: () => void | Promise<void>;
  onOpenTranscripts: () => void | Promise<void>;
  onBackendChange: (backend: BlinkBackend) => void | Promise<void>;
  onQuit: () => void;
}

interface TrayOptions {
  store: AppStateStore;
  callbacks: TrayCallbacks;
  assetsDir: string;
}

export interface TrayHandle {
  refresh(): void;
  dispose(): void;
  readonly tray: Tray;
}

const PROCESSING_FRAME_MS = 500;

type IconVariant =
  | "idle"
  | "monitoring"
  | "processingA"
  | "processingB"
  | "error"
  | "hidden";

function iconFile(variant: IconVariant): string {
  switch (variant) {
    case "hidden":
      return "iconTemplate-hidden.png";
    case "idle":
      return "iconTemplate.png";
    case "monitoring":
      return "iconTemplate-monitoring.png";
    case "processingA":
      return "iconTemplate-processing.png";
    case "processingB":
      return "iconTemplate-processing-b.png";
    case "error":
      return "iconTemplate-error.png";
  }
}

function pickVariant(state: AppState, processingFrame: 0 | 1): IconVariant {
  if (state.hideFromCapture) return "hidden";
  if (state.lastError !== undefined) return "error";
  if (state.monitoringStarting || state.meetingStarting || state.meetingAsking) {
    return processingFrame === 0 ? "processingA" : "processingB";
  }
  if (state.monitoring || state.meeting) return "monitoring";
  return "idle";
}

function tooltipFor(state: AppState): string {
  if (state.lastError !== undefined) return `Blink: ${state.lastError}`;
  if (state.monitoringStarting) return "Blink: starting Monitor…";
  if (state.meetingStarting) return "Blink: starting Meeting…";
  if (state.meetingAsking) return "Blink: answering…";
  if (state.monitoring && state.meeting) return "Blink: Monitor and Meeting active";
  if (state.monitoring) return "Blink: monitoring";
  if (state.meeting) return "Blink: Meeting active";
  return "Blink";
}

/**
 * Load and template-mark the image for one variant. Cached across refreshes
 * so we don't hit the disk on every tick of the processing animation.
 */
class IconCache {
  private readonly cache = new Map<IconVariant, NativeImage>();
  constructor(private readonly assetsDir: string) {}

  get(variant: IconVariant): NativeImage {
    const cached = this.cache.get(variant);
    if (cached !== undefined) return cached;
    const filepath = path.join(this.assetsDir, iconFile(variant));
    const img = nativeImage.createFromPath(filepath);
    img.setTemplateImage(true);
    this.cache.set(variant, img);
    return img;
  }
}

export function buildTray(opts: TrayOptions): TrayHandle {
  const icons = new IconCache(opts.assetsDir);
  const tray = new Tray(icons.get("idle"));
  let processingFrame: 0 | 1 = 0;
  let animationTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const runAction = (action: () => void | Promise<void>): void => {
    Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        opts.store.update({ lastError: message });
      });
  };

  const stopAnimation = (): void => {
    if (animationTimer !== null) {
      clearInterval(animationTimer);
      animationTimer = null;
    }
    processingFrame = 0;
  };

  const startAnimation = (): void => {
    if (animationTimer !== null) return;
    animationTimer = setInterval(() => {
      if (disposed) return;
      processingFrame = processingFrame === 0 ? 1 : 0;
      const state = opts.store.get();
      tray.setImage(icons.get(pickVariant(state, processingFrame)));
    }, PROCESSING_FRAME_MS);
  };

  const buildMenu = (state: AppState): Menu => {
    const backends = backendMenu(state.backend, (backend) => {
      runAction(() => opts.callbacks.onBackendChange(backend));
    });
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Answer Popup",
        click: () => {
          runAction(opts.callbacks.onShowPopup);
        },
      },
      {
        label: "Open Presenter Notes",
        click: () => {
          runAction(opts.callbacks.onShowPresenter);
        },
      },
      { type: "separator" },
      {
        label: "Custom Prompts…",
        click: () => {
          runAction(opts.callbacks.onOpenConfig);
        },
      },
      {
        label: "Answer Log…",
        click: () => {
          runAction(opts.callbacks.onOpenAnswerLog);
        },
      },
      {
        label: "Meeting Transcripts…",
        click: () => {
          runAction(opts.callbacks.onOpenTranscripts);
        },
      },
      { label: backends.label, submenu: [...backends.submenu] },
      { type: "separator" },
      {
        label: "Permissions",
        submenu: [
          {
            label: "Setup Assistant…",
            click: () => {
              runAction(opts.callbacks.onOpenWelcome);
            },
          },
          { type: "separator" },
          {
            label: "Microphone Access…",
            click: () => {
              runAction(() => opts.callbacks.onOpenPermission("microphone"));
            },
          },
          {
            label: "Screen & System Audio Recording…",
            click: () => {
              runAction(() => opts.callbacks.onOpenPermission("screen"));
            },
          },
        ],
      },
      {
        label: "Reveal Blink.app in Finder",
        click: () => {
          runAction(opts.callbacks.onRevealBundle);
        },
      },
      {
        label: "Show Saved Screenshots in Finder…",
        click: () => {
          runAction(opts.callbacks.onShowSavedScreenshots);
        },
      },
      { type: "separator" },
      {
        label: "Quit Blink",
        click: () => {
          opts.callbacks.onQuit();
        },
      },
    ];
    return Menu.buildFromTemplate(template);
  };

  const refresh = (): void => {
    if (disposed) return;
    const state = opts.store.get();
    tray.setImage(icons.get(pickVariant(state, processingFrame)));
    tray.setToolTip(tooltipFor(state));
    tray.setContextMenu(buildMenu(state));
    if (state.monitoringStarting || state.meetingStarting || state.meetingAsking) startAnimation();
    else stopAnimation();
  };

  refresh();
  const unsubscribe = opts.store.subscribe(refresh);

  return {
    refresh,
    tray,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopAnimation();
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
