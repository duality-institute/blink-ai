import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_PRESENTER_NOTES_BYTES = 512 * 1024;

function assertWithinSizeLimit(size: number): void {
  if (size > MAX_PRESENTER_NOTES_BYTES) {
    throw new Error(
      `Presenter notes exceed the ${MAX_PRESENTER_NOTES_BYTES}-byte limit`,
    );
  }
}

export function loadPresenterNotes(filePath: string): string {
  try {
    const contents = fs.readFileSync(filePath);
    assertWithinSizeLimit(contents.byteLength);
    return contents.toString("utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

export function savePresenterNotes(filePath: string, markdown: string): void {
  const size = Buffer.byteLength(markdown, "utf8");
  assertWithinSizeLimit(size);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, markdown, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
