import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { OpenCodeProcess } from "./opencode-process";

const StateSchema = z.object({
  args: z.array(z.string()),
  password: z.string(),
  config: z.string(),
});

const roots: string[] = [];
const processes: OpenCodeProcess[] = [];

afterEach(async () => {
  for (const managedProcess of processes.splice(0)) {
    await managedProcess.stop();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function executable(root: string, source: string): string {
  const filePath = path.join(root, "fake-opencode");
  fs.writeFileSync(filePath, `#!/usr/bin/env bun\n${source}`);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe("OpenCodeProcess", () => {
  it("starts one warm child with isolated credentials and stops it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blink-process-"));
    roots.push(root);
    const statePath = path.join(root, "state.txt");
    const binary = executable(
      root,
      `
import * as fs from "node:fs";
const statePath = process.env["BLINK_TEST_STATE"];
if (statePath === undefined) throw new Error("missing state path");
fs.writeFileSync(statePath, JSON.stringify({
  args: process.argv.slice(2),
  password: process.env["OPENCODE_SERVER_PASSWORD"],
  config: process.env["OPENCODE_CONFIG_CONTENT"],
}));
const port = process.argv.find((value) => value.startsWith("--port="))?.slice(7);
process.stdout.write("opencode server lis");
setTimeout(() => process.stdout.write("tening on http://127.0.0.1:" + port + "\\n"), 5);
process.on("SIGTERM", () => {
  fs.appendFileSync(statePath, "\\nstopped");
  process.exit(0);
});
setInterval(() => undefined, 1_000);
`,
    );
    const managedProcess = new OpenCodeProcess({
      binary,
      port: 4555,
      workingDirectory: path.join(root, "workspace"),
      environment: { BLINK_TEST_STATE: statePath },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 100,
    });
    processes.push(managedProcess);

    const endpoint = await managedProcess.start();
    expect(await managedProcess.start()).toEqual(endpoint);
    expect(endpoint.url).toBe("http://127.0.0.1:4555");
    const state = StateSchema.parse(
      JSON.parse(fs.readFileSync(statePath, "utf8")),
    );
    expect(state.args).toEqual([
      "serve",
      "--hostname=127.0.0.1",
      "--port=4555",
    ]);
    expect(state.password).toBe(endpoint.password);
    expect(endpoint.password.length).toBeGreaterThan(32);
    expect(JSON.parse(state.config)).toEqual({
      attachment: {
        image: {
          max_width: 4096,
          max_height: 4096,
          max_base64_bytes: 20_000_000,
        },
      },
    });

    await managedProcess.stop();
    expect(await managedProcess.waitForExit()).toBeNull();
    expect(fs.readFileSync(statePath, "utf8")).toEndWith("\nstopped");
  });

  it("rejects when the child exits before reporting ready", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blink-process-"));
    roots.push(root);
    const managedProcess = new OpenCodeProcess({
      binary: executable(root, 'process.stderr.write("startup failed\\n");\n'),
      port: 4555,
      workingDirectory: path.join(root, "workspace"),
      startupTimeoutMs: 1_000,
    });
    processes.push(managedProcess);

    let failure: unknown;
    try {
      await managedProcess.start();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected startup failure");
    expect(failure.message).toContain("OpenCode exited before ready");
  });
});
