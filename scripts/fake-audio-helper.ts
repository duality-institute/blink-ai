#!/usr/bin/env bun

interface Args {
  chunkCount: number;
  crashAfterMs: number | null;
  fatalMessage: string | null;
  ignoreSigterm: boolean;
  malformed: boolean;
  transcript: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    chunkCount: 1,
    crashAfterMs: null,
    fatalMessage: null,
    ignoreSigterm: false,
    malformed: false,
    transcript: false,
  };
  for (const raw of argv) {
    const [key, value = ""] = raw.split("=", 2);
    switch (key) {
      case "--chunk":
        args.chunkCount = Math.max(1, Number(value));
        break;
      case "--crash-after":
        args.crashAfterMs = Number(value);
        break;
      case "--fatal":
        args.fatalMessage = value;
        break;
      case "--ignore-sigterm":
        args.ignoreSigterm = true;
        break;
      case "--malformed":
        args.malformed = true;
        break;
      case "--transcript":
        args.transcript = true;
        break;
    }
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeChunked(text: string, count: number): Promise<void> {
  const size = Math.max(1, Math.ceil(text.length / count));
  for (let offset = 0; offset < text.length; offset += size) {
    process.stdout.write(text.slice(offset, offset + size));
    if (count > 1) await sleep(10);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ignoreSigterm) process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  if (args.fatalMessage !== null) {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", message: args.fatalMessage })}\n`,
    );
    process.exit(1);
  }

  if (args.malformed) {
    process.stdout.write("not-json\n");
  } else {
    let output = `${JSON.stringify({ kind: "status", message: "starting" })}\n`;
    output += `${JSON.stringify({ kind: "ready" })}\n`;
    if (args.transcript) {
      output += `${JSON.stringify({
        kind: "transcript",
        speaker: "them",
        text: "Could you explain the design?",
        isFinal: true,
        startMs: 1_000,
        endMs: 3_000,
      })}\n`;
    }
    await writeChunked(output, args.chunkCount);
  }

  if (args.crashAfterMs !== null) {
    await sleep(args.crashAfterMs);
    process.stderr.write("simulated helper crash\n");
    process.exit(1);
  }

  const keepalive = setInterval(() => {}, 3_600_000);
  process.on("exit", () => clearInterval(keepalive));
}

void main();
