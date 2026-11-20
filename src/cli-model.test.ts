import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.join(import.meta.dir, "cli.ts");
const install = ["install", "--backend", "opencode", "--skip-global"];
const base = "router/vendor/vision";
const other = "local/other";

describe("OpenCode model setup", () => {
  let home: string;
  let bin: string;
  let config: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-model-"));
    bin = path.join(home, "bin");
    config = path.join(home, "config.json");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh
case "$*" in
  'debug config') printf '%s\\n' "$TEST_CONFIG" ;;
  'models') printf '%s\\n' "$TEST_MODELS"; exit "$TEST_MODELS_STATUS" ;;
  *) exit 9 ;;
esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "tccutil"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function run(args: string[], overrides: Record<string, string> = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: home, encoding: "utf8", timeout: 5_000,
      env: {
        ...process.env, HOME: home, BLINK_HOME: home, PATH: bin,
        TEST_CONFIG: JSON.stringify({ model: base, small_model: other }),
        TEST_MODELS: `${other}\n${base}`, TEST_MODELS_STATUS: "0", ...overrides,
      },
    });
  }

  it("saves the configured base model rather than the first available or small model", () => {
    const result = run(install);

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({ backend: "opencode", model: base });
    expect(result.stdout).toContain(base);
    expect(result.stdout).toContain("opencode models");
  });

  it.each([
    { problem: "no configured base", env: { TEST_CONFIG: JSON.stringify({ small_model: other }) } },
    { problem: "bad config output", env: { TEST_CONFIG: "not-json" } },
    { problem: "unlisted default", env: { TEST_MODELS: `${base}-preview` } },
    { problem: "unreadable catalog", env: { TEST_MODELS_STATUS: "1" } },
  ])("gives the config path on $problem without saving a substitute", ({ env }) => {
    const result = run(install, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(config);
    expect(result.stderr).toContain("opencode models");
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).not.toHaveProperty("model");
  });

  it("keeps an existing selection on reinstall unless --model overrides it", () => {
    fs.writeFileSync(config, JSON.stringify({ backend: "opencode", model: other }));
    const unavailableDefault = { TEST_CONFIG: "{}" };

    expect(run(install, unavailableDefault).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, "utf8")).model).toBe(other);
    expect(run([...install, "--model", base], unavailableDefault).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, "utf8")).model).toBe(base);
  });

  it("reports a missing OpenCode executable without switching away from a working backend", () => {
    fs.unlinkSync(path.join(bin, "opencode"));
    fs.writeFileSync(config, JSON.stringify({ backend: "codex", model: "native" }));
    const result = run(install);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(config);
    expect(result.stderr).toContain("PATH");
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({ backend: "codex", model: "native" });
  });

  it("repairs a malformed saved model without replacing unrelated preferences", () => {
    fs.writeFileSync(config, JSON.stringify({ backend: "opencode", model: "old", showTranscript: false, extra: 17 }));

    const result = run(["set-model", ` ${other} `]);

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({ model: other, showTranscript: false, extra: 17 });
  });

  it.each([[], ["missing-slash"], ["router/missing"], [base, other]])("rejects bad input without mutating settings (%j)", (...args) => {
    const original = JSON.stringify({ model: base });
    fs.writeFileSync(config, original);
    const result = run(["set-model", ...args]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("opencode models");
    expect(fs.readFileSync(config, "utf8")).toBe(original);
  });

  it("does not change the active Claude backend or its model", () => {
    const original = JSON.stringify({ backend: "claude", model: "native" });
    fs.writeFileSync(config, original);
    expect(run(["set-model", base]).status).toBe(1);
    expect(fs.readFileSync(config, "utf8")).toBe(original);
  });
});
