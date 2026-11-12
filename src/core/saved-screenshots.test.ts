import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveScreenshot, savedScreenshotsDirectory } from "./saved-screenshots";

describe("saved screenshots", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "blink-screenshots-"));
    process.env["BLINK_HOME"] = home;
  });

  afterEach(() => {
    delete process.env["BLINK_HOME"];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("retains private, separate copies even after a staged capture is removed", async () => {
    const staged = path.join(home, "blink-2026-09-26.png");
    fs.writeFileSync(staged, "capture pixels");

    const first = await archiveScreenshot(staged);
    const second = await archiveScreenshot(staged);
    fs.rmSync(staged);

    expect(savedScreenshotsDirectory()).toBe(path.join(home, "screenshots"));
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, "utf8")).toBe("capture pixels");
    expect(fs.readFileSync(second, "utf8")).toBe("capture pixels");
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(fs.statSync(savedScreenshotsDirectory()).mode & 0o777).toBe(0o700);
  });
});
