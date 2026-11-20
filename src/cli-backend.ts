import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import * as os from "node:os";
import * as path from "node:path";
import { resolveOpenCodeModel } from "./backends/opencode-model";
import {
  ensureProjectDir, getConfigPath, isOpenCodeModelId, loadConfig, OPENCODE_MODEL_HINT,
  saveConfig, selectBackend,
} from "./core/config";
import { BACKEND_LABELS, BLINK_BACKENDS, type BlinkBackend, type BlinkConfig } from "./core/types";

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals !== undefined) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseBackend(value: string): BlinkBackend {
  const normalized = value.trim().toLowerCase();
  const backend = BLINK_BACKENDS.find((candidate) => candidate === normalized);
  if (backend === undefined) {
    throw new Error(`Unknown backend: ${value}. Choose opencode, codex, or claude.`);
  }
  return backend;
}

export async function selectedBackend(args: string[], current: BlinkBackend): Promise<BlinkBackend | null> {
  const explicit = optionValue(args, "--backend");
  if (explicit !== undefined) return parseBackend(explicit);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive setup needs a terminal; pass --backend <name>.");
  }
  intro("Blink local backend setup");
  const result = await select({
    message: "Select an answer backend",
    initialValue: current,
    options: BLINK_BACKENDS.map((backend) => ({ value: backend, label: BACKEND_LABELS[backend] })),
  });
  if (isCancel(result)) {
    cancel("Setup cancelled.");
    return null;
  }
  return result;
}

export async function configureBackend(backend: BlinkBackend, args: string[] = []): Promise<BlinkConfig> {
  const config = selectBackend(loadConfig(), backend);
  const model = optionValue(args, "--model");
  const projectDir = optionValue(args, "--project-dir");
  if (model !== undefined) config.model = model;
  if (projectDir !== undefined) {
    config.projectDir = path.resolve(
      projectDir.startsWith("~") ? path.join(os.homedir(), projectDir.slice(1)) : projectDir,
    );
  }
  if (backend === "opencode") {
    if (config.model === undefined) console.log("Looking up the default model configured in OpenCode on this machine.");
    config.model = await resolveOpenCodeModel(config.model, await ensureProjectDir(config));
  }
  saveConfig(config);
  if (backend === "opencode") {
    console.log(`OpenCode model: ${config.model}`);
    console.log(`${OPENCODE_MODEL_HINT} To change Blink's model, paste the ID into \`blink-ai set-model\`.`);
  }
  return config;
}

export async function setModel(args: string[]): Promise<void> {
  const usage = `Usage: blink-ai set-model [provider/model]\n${OPENCODE_MODEL_HINT}`;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  let model = args[0];
  if (args.length > 1 || model?.startsWith("-")) throw new Error(usage);
  const config = loadConfig("replace-opencode-model");
  if (config.backend !== "opencode") {
    throw new Error(`Blink is using ${BACKEND_LABELS[config.backend]}. To switch, use \`blink-ai configure --backend opencode --model provider/model\`.\n${OPENCODE_MODEL_HINT}`);
  }
  if (model === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(usage);
    intro(OPENCODE_MODEL_HINT);
    const entry = await text({
      message: "Paste the OpenCode model ID",
      placeholder: "provider/model",
      validate: (value = "") => isOpenCodeModelId(value.trim()) ? undefined : "Paste a full provider/model ID.",
    });
    if (isCancel(entry)) {
      cancel("Model unchanged.");
      return;
    }
    model = entry;
  }
  const selected = await resolveOpenCodeModel(model, await ensureProjectDir(config));
  saveConfig({ ...config, model: selected });
  outro(`OpenCode model set to ${selected} in ${getConfigPath()}. Restart Blink to apply it.`);
}
