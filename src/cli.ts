#!/usr/bin/env bun

import { outro } from "@clack/prompts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { findExecutable } from "./backends/process-runner";
import { configureBackend, selectedBackend, setModel } from "./cli-backend";
import { getConfigPath, loadConfig } from "./core/config";
import {
  BACKEND_COMMANDS,
  BACKEND_LABELS,
  type BlinkBackend,
} from "./core/types";
import {
  BLINK_BUNDLE_ID,
  globalBinDir,
  PACKAGE_ROOT,
  reportBundle,
  resetGrantsAfterInstall,
  startApp,
  ungrant,
  uninstallApp,
} from "./cli-platform";
import { ensureOnPath } from "./shell-path";

export { BLINK_BUNDLE_ID };
export { configureBackend, parseBackend } from "./cli-backend";

const PackageMetadataSchema = z.object({ name: z.string(), version: z.string() });

const INSTALL_URLS: Readonly<Record<BlinkBackend, string>> = {
  opencode: "https://opencode.ai/docs",
  codex: "https://developers.openai.com/codex/cli",
  claude: "https://code.claude.com/docs/en/setup",
};

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command = "start", ...rest] = args;
  switch (command) {
    case "install":
      await install(rest);
      return;
    case "configure":
      await configure(rest);
      return;
    case "set-model":
      await setModel(rest);
      return;
    case "start":
      startApp();
      console.log("Blink launched successfully. Check the menu bar to open its menu.");
      console.log("If Private mode is on, the icon is invisible, but its space in the menu bar is still clickable.");
      return;
    case "doctor":
      doctor();
      return;
    case "ungrant":
      ungrant();
      return;
    case "uninstall":
      uninstallApp(readPackageMetadata().name);
      return;
    case "--version":
    case "-v":
    case "version":
      console.log(readPackageMetadata().version);
      return;
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run blink-ai --help.`);
  }
}

async function install(args: string[]): Promise<void> {
  const backend = await selectedBackend(args, loadConfig().backend);
  if (backend === null) return;
  await configureBackend(backend, args);
  reportBackend(backend);

  let reload: string | null = null;
  if (!args.includes("--skip-global")) {
    const metadata = readPackageMetadata();
    const existing = findExecutable("blink-ai");
    if (existing !== undefined) console.log(`Replacing existing blink-ai command at ${existing}`);
    const result = spawnSync(
      process.execPath,
      ["install", "--global", `${metadata.name}@${metadata.version}`],
      { stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Global installation failed with code ${result.status ?? 1}`);
    }
    reload = applyPathSetup();
  }

  resetGrantsAfterInstall();
  outro(
    reload === null
      ? `Configured ${BACKEND_LABELS[backend]} in ${getConfigPath()}. Run \`blink-ai\` to start.`
      : `Configured ${BACKEND_LABELS[backend]} in ${getConfigPath()}. Run \`${reload}\`, then \`blink-ai\` to start.`,
  );
}

function applyPathSetup(): string | null {
  const binDir = globalBinDir();
  if (binDir === null) return null;
  try {
    const setup = ensureOnPath({
      binDir,
      pathValue: process.env.PATH,
      shellPath: process.env.SHELL,
      home: os.homedir(),
    });
    switch (setup.kind) {
      case "already-on-path":
        return null;
      case "already-declared":
        console.log(`${setup.file} already adds ${binDir} to PATH; open a new terminal.`);
        return null;
      case "updated":
        console.log(`Added ${binDir} to PATH in ${setup.file}.`);
        return setup.reload;
      case "manual":
        console.log(`Add ${binDir} to PATH so the blink-ai command resolves:\n\n  ${setup.entry}\n`);
        return null;
    }
  } catch (error) {
    console.log(
      `Could not update PATH automatically: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(`Add ${binDir} to PATH to use the blink-ai command.`);
    return null;
  }
}

async function configure(args: string[]): Promise<void> {
  const backend = await selectedBackend(args, loadConfig().backend);
  if (backend === null) return;
  await configureBackend(backend, args);
  reportBackend(backend);
  outro(`Updated ${getConfigPath()}. Restart Blink to apply it.`);
}

function reportBackend(backend: BlinkBackend): void {
  const executable = findExecutable(BACKEND_COMMANDS[backend]);
  if (executable === undefined) {
    console.warn(
      `${BACKEND_LABELS[backend]} is not on PATH yet. Install and authenticate it: ${INSTALL_URLS[backend]}`,
    );
  } else {
    console.log(`${BACKEND_LABELS[backend]}: ${executable}`);
  }
}

function doctor(): void {
  const config = loadConfig();
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Backend: ${BACKEND_LABELS[config.backend]}`);
  console.log(`Model: ${config.model ?? "CLI default"}`);
  reportBackend(config.backend);
  reportBundle();
}

function readPackageMetadata(): z.infer<typeof PackageMetadataSchema> {
  const value: unknown = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  return PackageMetadataSchema.parse(value);
}

function printHelp(): void {
  console.log(`Blink local meeting copilot

Usage:
  blink-ai                       Start Blink
  blink-ai install               Configure and register the blink-ai command
  blink-ai configure             Change the local answer backend
  blink-ai set-model [id]        Set Blink's OpenCode model; run opencode models and paste a provider/model ID
  blink-ai doctor                Check config, app bundle, and backend availability
  blink-ai ungrant               Remove Blink's microphone and screen recording permissions
  blink-ai uninstall             Revoke permissions and uninstall Blink; keep saved data

Options:
  --backend <opencode|codex|claude>
  --model <id>                   Model override (OpenCode: provider/model)
  --project-dir <path>           Backend working directory
  --skip-global                  Configure without installing the global command
  --version                      Print the installed version

Blink runs as a menu-bar app and writes logs to ~/.blink-ai/blink.log.`);
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    console.error(`[blink] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
