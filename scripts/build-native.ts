import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";

/**
 * Builds `vendor/Blink.app`: the launcher that owns Blink's privacy identity,
 * with the audio helper as a plain executable inside it.
 *
 * The bundle is not cosmetic. macOS refuses to show a privacy prompt for an
 * unbundled process, so the bundle identifier and usage-description strings
 * are what give TCC something to prompt about.
 *
 * The helper deliberately has no bundle of its own. An identity down there
 * would let TCC register it as a second client and list "Blink Audio"
 * alongside "Blink"; with none, TCC must walk up to Blink.app, so microphone
 * and system audio both land under a single entry.
 */

const packageRoot = resolve(import.meta.dir, "..");
const launcherDir = resolve(packageRoot, "native", "launcher");
const helperDir = resolve(packageRoot, "native", "audio-helper");

const appDir = resolve(packageRoot, "vendor", "Blink.app");
const appContents = resolve(appDir, "Contents");
const appBinary = resolve(appContents, "MacOS", "Blink");
const helperBinary = resolve(appContents, "Helpers", "BlinkAudio");
const iconSource = resolve(packageRoot, "assets", "AppIcon.icns");

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function hasSwift(): boolean {
  return spawnSync("swift", ["--version"], { stdio: "ignore" }).status === 0;
}

function buildRelease(directory: string, product: string): string {
  run("swift", ["build", "-c", "release"], directory);
  const binary = resolve(directory, ".build", "release", product);
  if (!existsSync(binary)) {
    throw new Error(`swift build produced no binary at ${binary}`);
  }
  return binary;
}

function install(source: string, destination: string): void {
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

/**
 * Ad-hoc signing gives TCC a valid identity for this exact build without an
 * Apple Developer ID. Signing the bundle seals the helper along with it, so
 * the helper needs no signature — and no identity — of its own.
 */
function sign(bundle: string, identifier: string): void {
  run(
    "codesign",
    ["--force", "--sign", "-", "--identifier", identifier, bundle],
    packageRoot,
  );
}

/**
 * Rebuilding changes the bundle's code hash, and macOS keys TCC grants to that
 * hash, so every rebuild silently revokes the user's screen and microphone
 * permissions. The committed bundle is therefore reused unless a rebuild is
 * asked for explicitly, which keeps `make install` from resetting grants each
 * time. Set BLINK_REBUILD_NATIVE=1 after changing anything under native/.
 */
const rebuildRequested = process.env["BLINK_REBUILD_NATIVE"] === "1";
const prebuiltExists = existsSync(appBinary) && existsSync(helperBinary);

if (!rebuildRequested && prebuiltExists) {
  chmodSync(appBinary, 0o755);
  chmodSync(helperBinary, 0o755);
  run("codesign", ["--verify", "--deep", "--strict", appDir], packageRoot);
  console.log("using prebuilt vendor/Blink.app (BLINK_REBUILD_NATIVE=1 to rebuild)");
  process.exit(0);
}

if (!hasSwift()) {
  throw new Error("swift toolchain not found and no prebuilt Blink.app exists");
}

if (!existsSync(iconSource)) {
  throw new Error(
    `missing ${iconSource}; run \`bun scripts/make-app-icon.ts\` first`,
  );
}

const launcherBuild = buildRelease(launcherDir, "BlinkLauncher");
const helperBuild = buildRelease(helperDir, "BlinkAudio");

rmSync(appDir, { recursive: true, force: true });

install(launcherBuild, appBinary);
copyFileSync(
  resolve(launcherDir, "Resources", "Info.plist"),
  resolve(appContents, "Info.plist"),
);
mkdirSync(resolve(appContents, "Resources"), { recursive: true });
copyFileSync(iconSource, resolve(appContents, "Resources", "AppIcon.icns"));

install(helperBuild, helperBinary);

run("xcrun", ["strip", "-S", appBinary, helperBinary], packageRoot);
sign(appDir, "ai.blink.app");
run("codesign", ["--verify", "--deep", "--strict", appDir], packageRoot);

console.log("built vendor/Blink.app");
