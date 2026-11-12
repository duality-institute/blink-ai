import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigPath } from "./config";

export function savedScreenshotsDirectory(): string {
  return path.join(path.dirname(getConfigPath()), "screenshots");
}

export async function archiveScreenshot(source: string): Promise<string> {
  const directory = savedScreenshotsDirectory();
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${path.parse(source).name}-${randomUUID()}.png`);
  const image = await fs.promises.readFile(source);
  const file = await fs.promises.open(destination, "wx", 0o600);
  try {
    await file.writeFile(image);
  } finally {
    await file.close();
  }
  return destination;
}
