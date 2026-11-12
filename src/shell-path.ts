import * as fs from "node:fs";
import * as path from "node:path";

export const PATH_MARKER = "# Added by blink install";

export type SupportedShell = "zsh" | "bash" | "fish";

export type ShellProfile = {
  readonly file: string;
  readonly entry: string;
  readonly reload: string;
};

export type PathSetup =
  | { readonly kind: "already-on-path" }
  | { readonly kind: "already-declared"; readonly file: string }
  | { readonly kind: "updated"; readonly file: string; readonly reload: string }
  | { readonly kind: "manual"; readonly entry: string };

export type PathSetupInput = {
  readonly binDir: string;
  readonly pathValue: string | undefined;
  readonly shellPath: string | undefined;
  readonly home: string;
};

export function detectShell(shellPath: string | undefined): SupportedShell | null {
  const name = path.basename((shellPath ?? "").trim());
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  if (name === "fish") return "fish";
  return null;
}

export function isOnPath(pathValue: string | undefined, binDir: string): boolean {
  const target = normalizeDir(binDir);
  return (pathValue ?? "")
    .split(path.delimiter)
    .some((entry) => entry !== "" && normalizeDir(entry) === target);
}

export function profileFor(
  shell: SupportedShell,
  home: string,
  binDir: string,
): ShellProfile {
  switch (shell) {
    case "zsh":
      return {
        file: path.join(home, ".zshrc"),
        entry: `export PATH="${binDir}:$PATH"`,
        reload: "source ~/.zshrc",
      };
    case "bash":
      return {
        file: path.join(home, ".bash_profile"),
        entry: `export PATH="${binDir}:$PATH"`,
        reload: "source ~/.bash_profile",
      };
    case "fish":
      return {
        file: path.join(home, ".config", "fish", "config.fish"),
        entry: `fish_add_path ${binDir}`,
        reload: "source ~/.config/fish/config.fish",
      };
  }
}

export function alreadyDeclared(contents: string, binDir: string): boolean {
  return contents.includes(binDir) || contents.includes(PATH_MARKER);
}

export function appended(contents: string, entry: string): string {
  const separator = contents === "" || contents.endsWith("\n") ? "" : "\n";
  return `${contents}${separator}\n${PATH_MARKER}\n${entry}\n`;
}

export function ensureOnPath(input: PathSetupInput): PathSetup {
  if (isOnPath(input.pathValue, input.binDir)) return { kind: "already-on-path" };
  const shell = detectShell(input.shellPath);
  if (shell === null) {
    return { kind: "manual", entry: `export PATH="${input.binDir}:$PATH"` };
  }
  const profile = profileFor(shell, input.home, input.binDir);
  const contents = fs.existsSync(profile.file) ? fs.readFileSync(profile.file, "utf8") : "";
  if (alreadyDeclared(contents, input.binDir)) {
    return { kind: "already-declared", file: profile.file };
  }
  fs.mkdirSync(path.dirname(profile.file), { recursive: true });
  fs.writeFileSync(profile.file, appended(contents, profile.entry));
  return { kind: "updated", file: profile.file, reload: profile.reload };
}

function normalizeDir(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}
