import { app } from "electron";
import { getDefaults, loadConfig } from "../core/config";
import type { BlinkConfig } from "../core/types";
import { AppRuntime, formatRuntimeError } from "./app-runtime";

async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let config: BlinkConfig;
  let startupError: string | undefined;
  try {
    config = loadConfig();
  } catch (error) {
    config = getDefaults();
    startupError = formatRuntimeError(error);
  }

  const runtime = new AppRuntime(config, startupError);
  app.on("second-instance", () => runtime.showPopup());
  await app.whenReady();
  app.dock?.hide();
  runtime.bootstrap();

  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (runtime.isShuttingDown()) return;
    event.preventDefault();
    void runtime.shutdown().finally(() => app.exit(0));
  });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
}

start().catch((error) => {
  console.error("[blink] fatal:", error);
  process.exit(1);
});
