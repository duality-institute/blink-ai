import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  alreadyDeclared,
  appended,
  detectShell,
  ensureOnPath,
  isOnPath,
  PATH_MARKER,
  profileFor,
} from "./shell-path";

describe("shell PATH setup", () => {
  let home: string;
  const binDir = "/Users/test/.bun/bin";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-path-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("recognizes the shells it can configure", () => {
    expect(detectShell("/bin/zsh")).toBe("zsh");
    expect(detectShell("/opt/homebrew/bin/fish")).toBe("fish");
    expect(detectShell("/usr/local/bin/bash")).toBe("bash");
    expect(detectShell("/usr/bin/tcsh")).toBeNull();
    expect(detectShell(undefined)).toBeNull();
  });

  it("matches PATH entries regardless of trailing slashes", () => {
    expect(isOnPath(`/usr/bin:${binDir}:/bin`, binDir)).toBe(true);
    expect(isOnPath(`/usr/bin:${binDir}/`, binDir)).toBe(true);
    expect(isOnPath("/usr/bin:/bin", binDir)).toBe(false);
    expect(isOnPath(undefined, binDir)).toBe(false);
    expect(isOnPath("/usr/bin::/bin", "")).toBe(false);
  });

  it("does nothing when the directory is already on PATH", () => {
    const result = ensureOnPath({
      binDir,
      pathValue: `/usr/bin:${binDir}`,
      shellPath: "/bin/zsh",
      home,
    });

    expect(result.kind).toBe("already-on-path");
    expect(fs.existsSync(path.join(home, ".zshrc"))).toBe(false);
  });

  it("appends an export to .zshrc and reports the reload command", () => {
    fs.writeFileSync(path.join(home, ".zshrc"), 'alias ll="ls -la"');

    const result = ensureOnPath({ binDir, pathValue: "/usr/bin", shellPath: "/bin/zsh", home });

    expect(result).toEqual({
      kind: "updated",
      file: path.join(home, ".zshrc"),
      reload: "source ~/.zshrc",
    });
    const contents = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
    expect(contents).toContain('alias ll="ls -la"');
    expect(contents).toContain(PATH_MARKER);
    expect(contents).toContain(`export PATH="${binDir}:$PATH"`);
  });

  it("writes a fish function into a config directory that does not exist yet", () => {
    const result = ensureOnPath({
      binDir,
      pathValue: "/usr/bin",
      shellPath: "/opt/homebrew/bin/fish",
      home,
    });

    const config = path.join(home, ".config", "fish", "config.fish");
    expect(result).toEqual({
      kind: "updated",
      file: config,
      reload: "source ~/.config/fish/config.fish",
    });
    expect(fs.readFileSync(config, "utf8")).toContain(`fish_add_path ${binDir}`);
  });

  it("never appends the same directory twice", () => {
    const input = { binDir, pathValue: "/usr/bin", shellPath: "/bin/zsh", home } as const;
    ensureOnPath(input);
    const afterFirst = fs.readFileSync(path.join(home, ".zshrc"), "utf8");

    const second = ensureOnPath(input);

    expect(second).toEqual({ kind: "already-declared", file: path.join(home, ".zshrc") });
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe(afterFirst);
  });

  it("leaves an unsupported shell to the user", () => {
    const result = ensureOnPath({
      binDir,
      pathValue: "/usr/bin",
      shellPath: "/usr/bin/tcsh",
      home,
    });

    expect(result).toEqual({ kind: "manual", entry: `export PATH="${binDir}:$PATH"` });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("separates the block from a profile with no trailing newline", () => {
    expect(appended("alias ll='ls'", "export PATH=x")).toBe(
      `alias ll='ls'\n\n${PATH_MARKER}\nexport PATH=x\n`,
    );
    expect(appended("", "export PATH=x")).toBe(`\n${PATH_MARKER}\nexport PATH=x\n`);
  });

  it("treats a bun installer block as an existing declaration", () => {
    expect(alreadyDeclared(`export PATH="${binDir}:$PATH"`, binDir)).toBe(true);
    expect(alreadyDeclared(`${PATH_MARKER}\nexport PATH="$BUN_INSTALL/bin:$PATH"`, binDir)).toBe(true);
    expect(alreadyDeclared('alias ll="ls -la"', binDir)).toBe(false);
  });

  it("puts bash exports in .bash_profile", () => {
    expect(profileFor("bash", home, binDir)).toEqual({
      file: path.join(home, ".bash_profile"),
      entry: `export PATH="${binDir}:$PATH"`,
      reload: "source ~/.bash_profile",
    });
  });
});
