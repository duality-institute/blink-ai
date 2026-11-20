import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLINK_BUNDLE_ID, configureBackend, parseBackend, runCli } from "./cli";
import { loadConfig, saveConfig } from "./core/config";

describe("Blink CLI", () => {
  it("keeps the ungrant bundle id in step with the shipped app bundle", () => {
    const plist = fs.readFileSync(
      path.join(import.meta.dir, "..", "native", "launcher", "Resources", "Info.plist"),
      "utf8",
    );
    const identifier = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist,
    );

    expect(identifier?.[1]).toBe(BLINK_BUNDLE_ID);
  });

  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-cli-"));
    process.env.BLINK_HOME = home;
  });

  afterEach(() => {
    delete process.env.BLINK_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses supported backends", () => {
    expect(parseBackend("OpenCode")).toBe("opencode");
    expect(parseBackend("codex")).toBe("codex");
    expect(parseBackend(" claude ")).toBe("claude");
    expect(() => parseBackend("other")).toThrow(/Unknown backend/);
  });

  it("writes the selected backend and removes incompatible model defaults", async () => {
    await configureBackend("codex");
    const config = loadConfig();
    expect(config.backend).toBe("codex");
    expect(config.model).toBeUndefined();
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(true);
  });

  it("keeps desktop preferences when changing the local backend", async () => {
    saveConfig({ ...loadConfig(), showTranscript: false, monitorPrompt: "custom instruction" });

    await configureBackend("claude");

    expect(loadConfig()).toMatchObject({ backend: "claude", showTranscript: false, monitorPrompt: "custom instruction" });
  });

  it("configures a model and project directory through the command surface", async () => {
    const projectDir = path.join(home, "scratch");

    await runCli(["configure", "--backend", "codex", "--model", "test-model", "--project-dir", projectDir]);

    expect(loadConfig()).toMatchObject({ backend: "codex", model: "test-model", projectDir });
  });

  it("rejects a missing backend option value without replacing existing settings", async () => {
    const before = loadConfig();

    await expect(runCli(["configure", "--backend"])).rejects.toThrow(/requires a value/);

    expect(loadConfig()).toEqual(before);
  });
});
