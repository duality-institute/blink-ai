/**
 * Copy static renderer assets (HTML + CSS) from src to dist.
 * Bun's builder doesn't handle non-JS assets for a --target=browser entry,
 * so we copy them explicitly. Idempotent.
 */

import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const srcDir = resolve(import.meta.dir, "..", "src", "electron", "renderer");
const dstDir = resolve(import.meta.dir, "..", "dist", "electron", "renderer");

mkdirSync(dstDir, { recursive: true });

const assets = [
  "popup.html",
  "popup.css",
  "presenter.html",
  "presenter.css",
  "settings.html",
  "settings.css",
  "welcome.html",
  "welcome.css",
];
for (const name of assets) {
  copyFileSync(resolve(srcDir, name), resolve(dstDir, name));
  console.log(`copied ${name} → dist/electron/renderer/${name}`);
}
