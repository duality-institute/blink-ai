import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { BLINK_BACKENDS, type BlinkBackend, type BlinkConfig } from "./types";

const DEFAULTS: BlinkConfig = {
  backend: "opencode",
  hideFromCapture: true,
  showTranscript: true,
  monitorPrompt: "",
  meetingPrompt: "",
};

const OBSOLETE_KEYS = [
  "apiUrl",
  "accessToken",
  "sessionMode",
  "hotkeyPreset",
  "saveTranscript",
  "screenshotDir",
] as const;

const RawConfigSchema = z.record(z.string(), z.unknown());
const BackendSchema = z.enum(BLINK_BACKENDS);
const NonEmptyStringSchema = z.string().trim().min(1);

class ConfigFileError extends Error {
  override readonly name = "ConfigFileError";
}

export function getBlinkHome(): string {
  return process.env["BLINK_HOME"] ?? path.join(os.homedir(), ".blink-ai");
}

export function getConfigPath(): string {
  return path.join(getBlinkHome(), "config.json");
}

export async function ensureProjectDir(config: BlinkConfig): Promise<string> {
  const directory = config.projectDir ?? path.join(getBlinkHome(), "scratch");
  await fs.promises.mkdir(directory, { recursive: true });
  return directory;
}

export const OPENCODE_MODEL_HINT = "Run `opencode models` and copy a vision-capable provider/model ID.";

export class OpenCodeModelError extends Error {
  override readonly name = "OpenCodeModelError";

  constructor(reason: string) {
    super(`${reason}\n${OPENCODE_MODEL_HINT} Edit ${getConfigPath()}: set "backend" to "opencode" and "model" to the copied ID, then retry. If Blink already uses OpenCode, you can paste the ID into \`blink-ai set-model\` instead.`);
  }
}

export function isOpenCodeModelId(model: string): boolean {
  return /^[^\s/]+(?:\/[^\s/]+)+$/u.test(model);
}

function expandTilde(filePath: string): string {
  return filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
}

function validateModel(config: BlinkConfig): void {
  if (config.model === undefined) return;
  if (config.backend === "opencode" && !isOpenCodeModelId(config.model)) {
    throw new OpenCodeModelError("OpenCode model must use provider/model format.");
  }
  if (!NonEmptyStringSchema.safeParse(config.model).success) {
    throw new ConfigFileError("model must be a non-empty string");
  }
}

function withoutObsoleteKeys(
  user: Record<string, unknown>,
): { persisted: Record<string, unknown>; hadObsolete: boolean } {
  const persisted = { ...user };
  let hadObsolete = false;
  for (const key of OBSOLETE_KEYS) {
    if (key in persisted) {
      delete persisted[key];
      hadObsolete = true;
    }
  }
  return { persisted, hadObsolete };
}

function readUserConfig(configPath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigFileError(`Failed to parse config file at ${configPath}`);
    }
    throw error;
  }
  const parsed = RawConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigFileError(`Config file at ${configPath} must contain an object`);
  }
  return parsed.data;
}

export function loadConfig(purpose: "use" | "replace-opencode-model" = "use"): BlinkConfig {
  const blinkHome = getBlinkHome();
  const configPath = getConfigPath();
  fs.mkdirSync(blinkHome, { recursive: true });
  if (!fs.existsSync(configPath)) {
    if (purpose === "use") fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }

  const user = readUserConfig(configPath);
  const { persisted, hadObsolete } = withoutObsoleteKeys(user);
  const merged: BlinkConfig = { ...DEFAULTS };
  if (user["backend"] !== undefined) {
    const backend = BackendSchema.safeParse(user["backend"]);
    if (!backend.success) {
      throw new ConfigFileError(`backend must be one of ${BLINK_BACKENDS.join(", ")}`);
    }
    merged.backend = backend.data;
  }
  for (const key of ["model", "projectDir"] as const) {
    if (purpose === "replace-opencode-model" && merged.backend === "opencode" && key === "model") continue;
    if (user[key] === undefined) continue;
    const value = NonEmptyStringSchema.safeParse(user[key]);
    if (!value.success) {
      if (key === "model" && merged.backend === "opencode") {
        throw new OpenCodeModelError("OpenCode model must use provider/model format.");
      }
      throw new ConfigFileError(`${key} must be a non-empty string`);
    }
    merged[key] = key === "projectDir" ? path.resolve(expandTilde(value.data)) : value.data;
  }
  if (user["hideFromCapture"] !== undefined) {
    merged.hideFromCapture = user["hideFromCapture"] === true;
  }
  if (user["showTranscript"] !== undefined) {
    merged.showTranscript = user["showTranscript"] === true;
  }
  for (const key of ["monitorPrompt", "meetingPrompt"] as const) {
    if (user[key] === undefined) continue;
    const prompt = z.string().safeParse(user[key]);
    if (!prompt.success) throw new ConfigFileError(`${key} must be a string`);
    merged[key] = prompt.data.trim();
  }

  const missing = Object.keys(merged).filter((key) => !(key in persisted));
  validateModel(merged);
  if (purpose === "use" && (missing.length > 0 || hadObsolete)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...persisted, ...merged }, null, 2),
    );
  }
  return merged;
}

export function saveConfig(config: BlinkConfig): void {
  BackendSchema.parse(config.backend);
  validateModel(config);
  fs.mkdirSync(getBlinkHome(), { recursive: true });
  const configPath = getConfigPath();
  const { persisted } = withoutObsoleteKeys(
    fs.existsSync(configPath) ? readUserConfig(configPath) : {},
  );
  if (config.model === undefined) delete persisted["model"];
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...persisted, ...config }, null, 2),
  );
}

export function getDefaults(): BlinkConfig {
  return { ...DEFAULTS };
}

export function selectBackend(
  config: BlinkConfig,
  backend: BlinkBackend,
): BlinkConfig {
  const selected: BlinkConfig = { ...config, backend };
  if (backend !== config.backend) delete selected.model;
  return selected;
}
