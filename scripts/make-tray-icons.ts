#!/usr/bin/env bun
/**
 * Generate the tray template icons committed under `assets/tray/`.
 *
 * The tray on macOS renders best from a monochrome template image: a black
 * glyph on a transparent background, marked with `setTemplateImage(true)` at
 * load time so macOS can adapt it to the menu bar.
 *
 * We produce six states × two densities = 12 PNGs:
 *   iconTemplate.png                  22×22 idle (eye with 45° strike-through)
 *   iconTemplate@2x.png               44×44 idle
 *   iconTemplate-listening.png        22×22 listening (plain eye)
 *   iconTemplate-listening@2x.png     44×44 listening
 *   iconTemplate-processing.png       22×22 processing frame A (dashed eye)
 *   iconTemplate-processing@2x.png    44×44 processing frame A
 *   iconTemplate-processing-b.png     22×22 processing frame B (dashed, phase-shifted)
 *   iconTemplate-processing-b@2x.png  44×44 processing frame B
 *   iconTemplate-error.png            22×22 error (eye + badge)
 *   iconTemplate-error@2x.png         44×44 error
 *   iconTemplate-hidden.png           22×22 hidden (fully transparent)
 *   iconTemplate-hidden@2x.png        44×44 hidden
 *
 * Renders via headless Firefox.
 * SVG is rasterised in the browser at the exact target size to keep hairlines crisp.
 */

import { firefox } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

type State =
  | "idle"
  | "listening"
  | "processingA"
  | "processingB"
  | "error"
  | "hidden";

const OUT_DIR = path.join(process.cwd(), "assets", "tray");

const SIZES = [
  { suffix: "", px: 22 },
  { suffix: "@2x", px: 44 },
] as const;

const STATES: Array<{ state: State; base: string }> = [
  { state: "idle", base: "iconTemplate" },
  { state: "listening", base: "iconTemplate-listening" },
  { state: "processingA", base: "iconTemplate-processing" },
  { state: "processingB", base: "iconTemplate-processing-b" },
  { state: "error", base: "iconTemplate-error" },
  { state: "hidden", base: "iconTemplate-hidden" },
];

function svg(size: number, state: State): string {
  const cx = size / 2;
  const cy = size / 2;
  const ew = size * 0.42;
  const eh = size * 0.26;
  const pr = size * 0.14;
  const stroke = size >= 40 ? 3.5 : 1.8;

  const eye = `
      <ellipse cx="${cx}" cy="${cy}" rx="${ew}" ry="${eh}" fill="none" stroke="black" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${pr}" fill="black"/>
  `;

  let body = "";
  if (state === "hidden") {
    body = "";
  } else if (state === "idle") {
    const inset = size * 0.14;
    body = `
      ${eye}
      <line x1="${inset}" y1="${inset}" x2="${size - inset}" y2="${size - inset}"
        stroke="black" stroke-width="${stroke}" stroke-linecap="round"/>
    `;
  } else if (state === "listening") {
    body = eye;
  } else if (state === "processingA") {
    const dash = size >= 40 ? "6,4" : "3,2";
    body = `
      <ellipse cx="${cx}" cy="${cy}" rx="${ew}" ry="${eh}"
        fill="none" stroke="black" stroke-width="${stroke}"
        stroke-dasharray="${dash}"/>
      <circle cx="${cx}" cy="${cy}" r="${pr}" fill="black"/>
    `;
  } else if (state === "processingB") {
    // Phase-shifted: same dash pattern but offset so alternation reads as motion.
    const dash = size >= 40 ? "6,4" : "3,2";
    const offset = size >= 40 ? 5 : 2.5;
    body = `
      <ellipse cx="${cx}" cy="${cy}" rx="${ew}" ry="${eh}"
        fill="none" stroke="black" stroke-width="${stroke}"
        stroke-dasharray="${dash}" stroke-dashoffset="${offset}"/>
      <circle cx="${cx}" cy="${cy}" r="${pr}" fill="black"/>
    `;
  } else {
    // error: eye + solid badge at top-right
    const br = size * 0.18;
    const bx = size - br - 1;
    const by = br + 1;
    body = `
      <ellipse cx="${cx}" cy="${cy}" rx="${ew}" ry="${eh}" fill="none" stroke="black" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${pr}" fill="black"/>
      <circle cx="${bx}" cy="${by}" r="${br}" fill="black"/>
    `;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">
    ${body}
  </svg>`;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await firefox.launch();
  try {
    for (const { state, base } of STATES) {
      for (const { suffix, px } of SIZES) {
        const context = await browser.newContext({
          viewport: { width: px, height: px },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        const html = `<!DOCTYPE html>
<html>
<head><style>
  html,body{margin:0;padding:0;background:transparent;width:${px}px;height:${px}px;overflow:hidden}
  svg{display:block}
</style></head>
<body>${svg(px, state)}</body>
</html>`;
        await page.setContent(html);
        const target = path.join(OUT_DIR, `${base}${suffix}.png`);
        const dataUrl = await page.evaluate(async (size: number) => {
          const svgEl = document.querySelector("svg") as SVGSVGElement | null;
          if (!svgEl) throw new Error("svg missing");
          const svgSrc = new XMLSerializer().serializeToString(svgEl);
          const svgBlob = new Blob([svgSrc], { type: "image/svg+xml" });
          const svgUrl = URL.createObjectURL(svgBlob);
          try {
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error("img failed"));
              img.src = svgUrl;
            });
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d ctx");
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, 0, 0, size, size);
            return canvas.toDataURL("image/png");
          } finally {
            URL.revokeObjectURL(svgUrl);
          }
        }, px);
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        // Buffer → Uint8Array<ArrayBuffer> — strict tsconfig rejects Buffer for writeFileSync.
        const buf = Buffer.from(b64, "base64");
        const bytes = new Uint8Array(buf.byteLength);
        bytes.set(buf);
        fs.writeFileSync(target, bytes);
        await context.close();
        const stat = fs.statSync(target);
        console.log(`  ${path.basename(target)}  ${px}×${px}  ${stat.size}B`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nWrote ${STATES.length * SIZES.length} icons to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("make-tray-icons failed:", err);
  process.exit(1);
});
