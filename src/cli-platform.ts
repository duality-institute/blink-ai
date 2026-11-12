import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveAppBundlePath } from "./electron/meeting-listener";
import { getBlinkHome } from "./core/config";

export const BLINK_BUNDLE_ID = "ai.blink.app";
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function ungrant(): void {
  if (process.platform !== "darwin") throw new Error("Blink currently requires macOS.");
  if (!resetGrants()) {
    console.log(
      `No permissions recorded for ${BLINK_BUNDLE_ID}. Launch Blink once so macOS knows the app, then retry.`,
    );
    return;
  }
  console.log(
    "Cleared. Blink asks for Microphone and Screen & System Audio Recording again next launch.",
  );
}

export function uninstallApp(packageName: string): void {
  if (process.platform !== "darwin") throw new Error("Blink currently requires macOS.");
  resetGrants();
  const result = spawnSync(
    process.execPath,
    ["remove", "--global", packageName],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Uninstall failed with code ${result.status ?? 1}`);
  }
  console.log("Blink uninstalled.");
  console.log(`Your local data is still saved in ${getBlinkHome()}. Delete this folder manually if you no longer need it.`);
}

/**
 * Blink.app is ad-hoc signed, so its code hash changes on every release. macOS
 * keys TCC grants to that hash, leaving the old record visible and switched on
 * while silently denying capture. Clearing on install forces a fresh prompt.
 * Drop this once the bundle ships with a stable Developer ID signature.
 */
export function resetGrantsAfterInstall(): void {
  if (process.platform !== "darwin") return;
  try {
    if (resetGrants()) {
      console.log("Cleared macOS permissions so Blink can request them fresh.");
    }
  } catch (error) {
    console.log(
      `Could not reset macOS permissions automatically: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log("Run `blink-ai ungrant` if capture or the microphone is denied.");
  }
}

function resetGrants(): boolean {
  const result = spawnSync("tccutil", ["reset", "All", BLINK_BUNDLE_ID], {
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) {
    console.log(`Reset permissions for ${BLINK_BUNDLE_ID}`);
    return true;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.includes("No such bundle identifier")) return false;
  throw new Error(`tccutil failed for ${BLINK_BUNDLE_ID}: ${output.trim()}`);
}

export function globalBinDir(): string | null {
  const result = spawnSync(process.execPath, ["pm", "bin", "-g"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  const dir = (result.stdout ?? "").trim();
  return dir === "" ? null : dir;
}

export function reportBundle(): void {
  const bundle = resolveAppBundlePath(PACKAGE_ROOT);
  if (!fs.existsSync(bundle)) {
    console.log(`Blink.app: missing at ${bundle} (run \`bun run build\`)`);
    return;
  }
  const signature = spawnSync("codesign", ["--verify", "--strict", bundle]);
  const valid = signature.status === 0 ? "signature valid" : "signature invalid";
  console.log(`Blink.app: ${bundle} (${valid})`);
  console.log(`Reveal it:  open -R "${bundle}"`);
}

export function startApp(): void {
  if (process.platform !== "darwin") throw new Error("Blink currently requires macOS.");
  const mainPath = path.join(PACKAGE_ROOT, "dist", "electron", "main.js");
  if (!fs.existsSync(mainPath)) {
    throw new Error("Blink is not built. Run `bun run build` first.");
  }
  launchBundle(resolveElectronBinary());
}

function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url);
  const electronModule: unknown = require("electron");
  if (typeof electronModule !== "string") {
    throw new Error("Unable to resolve the Electron executable.");
  }
  return electronModule;
}

function launchBundle(electronBinary: string): void {
  const bundle = resolveAppBundlePath(PACKAGE_ROOT);
  if (!fs.existsSync(bundle)) {
    throw new Error(`Blink.app is missing at ${bundle}. Run \`bun run build\`.`);
  }
  const result = spawnSync(
    "open",
    ["-n", "-a", bundle, "--args", PACKAGE_ROOT, electronBinary],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not open ${bundle} (code ${result.status ?? 1})`);
  }
}
