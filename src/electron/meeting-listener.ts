import path from "node:path";

export function resolveAppBundlePath(appPath: string): string {
  return path.join(appPath, "vendor", "Blink.app");
}

export function resolveAudioHelperPath(appPath: string): string {
  return path.join(
    resolveAppBundlePath(appPath),
    "Contents",
    "Helpers",
    "BlinkAudio",
  );
}
