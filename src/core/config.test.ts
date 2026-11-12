import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_OPENCODE_MODEL, getDefaults, loadConfig, saveConfig, selectBackend } from "./config";

describe("config", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blink-config-"));
    process.env["BLINK_HOME"] = tempDir;
  });

  afterEach(() => {
    delete process.env["BLINK_HOME"];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates local backend defaults on first run", () => {
    const config = loadConfig();

    expect(config.backend).toBe("opencode");
    expect(config.model).toBe(DEFAULT_OPENCODE_MODEL);
    expect(Object.hasOwn(config, "sessionMode")).toBe(false);
    expect(config.hideFromCapture).toBe(true);
    expect(Object.hasOwn(config, "screenshotDir")).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "config.json"))).toBe(true);
  });

  it("loads local preferences and removes obsolete cloud credentials and session mode", () => {
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        apiUrl: "https://blink.example.test/api",
        accessToken: "blink_customer_token",
        backend: "claude",
        sessionMode: "fresh",
        hideFromCapture: false,
      }),
    );

    const config = loadConfig();

    expect(config.backend).toBe("claude");
    expect(config.model).toBeUndefined();
    expect(config.hideFromCapture).toBe(false);
    expect(Object.hasOwn(config, "sessionMode")).toBe(false);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tempDir, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(onDisk, "sessionMode")).toBe(false);
    expect(Object.hasOwn(onDisk, "apiUrl")).toBe(false);
    expect(Object.hasOwn(onDisk, "accessToken")).toBe(false);
  });

  it("rejects an unsupported local backend", () => {
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({ backend: "azure" }),
    );

    expect(() => loadConfig()).toThrow(/backend/);
  });

  it("drops obsolete session, hotkey, transcript, and screenshot-dir keys", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        sessionMode: "other",
        hotkeyPreset: "oneHanded",
        saveTranscript: false,
        screenshotDir: "~/my-screenshots",
      }),
    );
    expect(Object.hasOwn(loadConfig(), "screenshotDir")).toBe(false);
    const migrated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(migrated, "sessionMode")).toBe(false);
    expect(Object.hasOwn(migrated, "hotkeyPreset")).toBe(false);
    expect(Object.hasOwn(migrated, "saveTranscript")).toBe(false);
    expect(Object.hasOwn(migrated, "screenshotDir")).toBe(false);
  });

  it("materializes newly added settings without dropping unknown keys", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ experimentalThing: "keep me" }));

    loadConfig();

    const onDisk: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk).toMatchObject({
      backend: "opencode",
      model: DEFAULT_OPENCODE_MODEL,
      experimentalThing: "keep me",
    });
  });

  it("leaves a complete config file byte-identical", () => {
    const configPath = path.join(tempDir, "config.json");
    loadConfig();
    const first = fs.readFileSync(configPath, "utf8");

    loadConfig();

    expect(fs.readFileSync(configPath, "utf8")).toBe(first);
  });

  it("reports malformed JSON with the config path", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "{bad json");

    expect(() => loadConfig()).toThrow(configPath);
  });

  it("saves the selected local backend and model", () => {
    saveConfig({
      backend: "codex",
      model: "test-model",
      hideFromCapture: true,
      showTranscript: true,
      monitorPrompt: "",
      meetingPrompt: "",
    });

    const saved: unknown = JSON.parse(
      fs.readFileSync(path.join(tempDir, "config.json"), "utf8"),
    );
    expect(saved).toMatchObject({
      backend: "codex",
      model: "test-model",
    });
    expect(Object.hasOwn(saved as object, "sessionMode")).toBe(false);
  });

  it("preserves unrelated settings when saving preferences", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ experimentalThing: "keep me", sessionMode: "fresh" }),
    );

    saveConfig({
      backend: "claude",
      hideFromCapture: false,
      showTranscript: false,
      monitorPrompt: "",
      meetingPrompt: "",
    });

    const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved["experimentalThing"]).toBe("keep me");
    expect(Object.hasOwn(saved, "sessionMode")).toBe(false);
  });

  it("returns independent default objects", () => {
    const first = getDefaults();
    const second = getDefaults();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("clears the previous backend model on disk when switching backends", () => {
    const current = loadConfig();

    saveConfig(selectBackend(current, "codex"));

    expect(loadConfig().model).toBeUndefined();
    expect(loadConfig().backend).toBe("codex");
  });

  it("requires qualified OpenCode models but accepts native CLI model names", () => {
    const config = getDefaults();

    expect(() => saveConfig({ ...config, model: "unqualified" })).toThrow(/provider\/model/);
    expect(() => saveConfig({ ...config, backend: "claude", model: "native-model" })).not.toThrow();
  });
});
