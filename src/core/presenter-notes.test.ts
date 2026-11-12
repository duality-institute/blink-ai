import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPresenterNotes,
  MAX_PRESENTER_NOTES_BYTES,
  savePresenterNotes,
} from "./presenter-notes";

const directories: string[] = [];

function notesPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blink-notes-"));
  directories.push(directory);
  return path.join(directory, "nested", "presenter.md");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("presenter notes", () => {
  it("loads an empty document when the file does not exist", () => {
    expect(loadPresenterNotes(notesPath())).toBe("");
  });

  it("atomically saves and replaces Markdown", () => {
    const filePath = notesPath();
    savePresenterNotes(filePath, "# First\n\nHello 👋");
    expect(loadPresenterNotes(filePath)).toBe("# First\n\nHello 👋");

    savePresenterNotes(filePath, "## Updated");
    expect(loadPresenterNotes(filePath)).toBe("## Updated");
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["presenter.md"]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized content without replacing the saved document", () => {
    const filePath = notesPath();
    savePresenterNotes(filePath, "keep me");

    expect(() =>
      savePresenterNotes(filePath, "x".repeat(MAX_PRESENTER_NOTES_BYTES + 1)),
    ).toThrow(/exceed/);
    expect(loadPresenterNotes(filePath)).toBe("keep me");
  });

  it("rejects an oversized notes file on load", () => {
    const filePath = notesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "x".repeat(MAX_PRESENTER_NOTES_BYTES + 1));

    expect(() => loadPresenterNotes(filePath)).toThrow(/exceed/);
  });
});
