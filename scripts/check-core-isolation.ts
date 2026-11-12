#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..");
const CORE_DIR = join(REPO_ROOT, "src", "core");

async function typescriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typescriptFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function isElectronImport(specifier: string): boolean {
  return specifier === "electron" || specifier.startsWith("electron/");
}

async function findViolations(): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await typescriptFiles(CORE_DIR)) {
    const source = await readFile(file, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      if (!isElectronImport(imported.fileName)) continue;
      const line = source.slice(0, imported.pos).split("\n").length;
      violations.push(`${relative(REPO_ROOT, file)}:${line}`);
    }
  }
  return violations.sort();
}

try {
  const violations = await findViolations();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Failed to check core isolation:", error);
  process.exitCode = 1;
}
