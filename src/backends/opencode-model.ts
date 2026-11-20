import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { isOpenCodeModelId, OpenCodeModelError } from "../core/config";

const exec = promisify(execFile);
const ModelConfig = z.object({ model: z.string().optional() });

async function queryOpenCode(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("opencode", args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stripVTControlCharacters(stdout).trim();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ("code" in error && error.code === "ENOENT") {
      throw new OpenCodeModelError("OpenCode was not found on PATH. Install and authenticate it first.");
    }
    throw new OpenCodeModelError(`Could not read the output of \`opencode ${args.join(" ")}\`.`);
  }
}

async function configuredDefault(cwd: string): Promise<string> {
  const output = await queryOpenCode(["debug", "config"], cwd);
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new OpenCodeModelError("OpenCode did not return its configuration as JSON.");
  }
  const parsed = ModelConfig.safeParse(raw);
  if (!parsed.success || !parsed.data.model?.trim()) {
    throw new OpenCodeModelError("OpenCode has no configured default model that Blink can read.");
  }
  return parsed.data.model.trim();
}

export async function resolveOpenCodeModel(requested: string | undefined, cwd: string): Promise<string> {
  const model = requested?.trim() ?? await configuredDefault(cwd);
  if (!isOpenCodeModelId(model)) throw new OpenCodeModelError("OpenCode model must use provider/model format.");
  const catalog = await queryOpenCode(["models"], cwd);
  if (!catalog.split(/\r?\n/u).some((line) => line.trim() === model)) {
    throw new OpenCodeModelError(`OpenCode does not list ${model} as an available model.`);
  }
  return model;
}
