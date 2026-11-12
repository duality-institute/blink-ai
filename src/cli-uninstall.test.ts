import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const homes: string[] = [];
const cli = path.join(import.meta.dir, "cli.ts");
const reset = "tccutil reset All ai.blink.app";
const remove = "bun remove --global @dualityinstitute/blink-ai";

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("uninstall command", () => {
  it.each([
    { scenario: "permissions are reset", resetStatus: 0, resetError: "", removeStatus: 0, exitCode: 0, calls: [reset, remove] },
    { scenario: "no permission record exists", resetStatus: 1, resetError: "No such bundle identifier", removeStatus: 0, exitCode: 0, calls: [reset, remove] },
    { scenario: "permission reset fails", resetStatus: 1, resetError: "Permission reset denied", removeStatus: 0, exitCode: 1, calls: [reset] },
    { scenario: "package removal fails", resetStatus: 0, resetError: "", removeStatus: 7, exitCode: 1, calls: [reset, remove] },
  ])("handles removal safely when $scenario", async (fixture) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-uninstall-"));
    homes.push(home);
    const bin = path.join(home, "bin");
    const log = path.join(home, "commands.log");
    const saved = path.join(home, "saved-transcript.md");
    fs.mkdirSync(bin);
    fs.writeFileSync(saved, "Keep this transcript.");
    fs.writeFileSync(path.join(bin, "tccutil"), `#!/bin/sh
printf 'tccutil %s %s %s\\n' "$1" "$2" "$3" >> "$BLINK_TEST_COMMAND_LOG"
printf '%s\\n' "$BLINK_TEST_RESET_ERROR" >&2
exit "$BLINK_TEST_RESET_STATUS"
`, { mode: 0o755 });
    const packageManager = path.join(bin, "bun");
    fs.writeFileSync(packageManager, `#!/bin/sh
printf 'bun %s %s %s\\n' "$1" "$2" "$3" >> "$BLINK_TEST_COMMAND_LOG"
exit "$BLINK_TEST_REMOVE_STATUS"
`, { mode: 0o755 });

    const child = Bun.spawn([process.execPath, "--eval", `
import { runCli } from ${JSON.stringify(cli)};
process.execPath = ${JSON.stringify(packageManager)};
try { await runCli(["uninstall"]); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`], {
      cwd: home,
      env: {
        ...process.env,
        PATH: bin,
        BUN_INSTALL: path.join(home, "bun-install"),
        BLINK_HOME: home,
        BLINK_TEST_COMMAND_LOG: log,
        BLINK_TEST_RESET_STATUS: String(fixture.resetStatus),
        BLINK_TEST_RESET_ERROR: fixture.resetError,
        BLINK_TEST_REMOVE_STATUS: String(fixture.removeStatus),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(fixture.exitCode);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([...fixture.calls]);
    expect(fs.readFileSync(saved, "utf8")).toBe("Keep this transcript.");
  });
});
