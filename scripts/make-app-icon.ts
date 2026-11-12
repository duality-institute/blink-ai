#!/usr/bin/env bun
/**
 * Generate `assets/AppIcon.icns`, the icon for `vendor/Blink.app`.
 *
 * This is the icon macOS shows in the permission prompt and in the
 * Privacy & Security lists. Without it those rows render a blank generic
 * icon, which is exactly what an unidentified binary looks like — so the
 * icon is the only thing letting someone recognise Blink in that list.
 *
 * It is the tray eye, drawn with the tray's proportions, on a white macOS
 * squircle with standard padding. Tray templates are black on transparent and
 * the menu bar inverts them; an app icon has to be opaque, so the white tile
 * keeps the glyph readable in a dark permission prompt.
 *
 * Renders via headless Firefox at each exact size, then `iconutil` packs the
 * `.iconset` into an `.icns`. Rasterising per size keeps the glyph crisp
 * instead of resampling one large bitmap down to 16px.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { firefox } from "playwright";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const OUT_ICNS = path.join(PACKAGE_ROOT, "assets", "AppIcon.icns");

// package.json ships `assets/` wholesale, and an allowlisted directory is not
// filtered by .gitignore, so a half-finished iconset left there by a crashed
// run would be published to npm. Build intermediates stay out of the tree.
const ICONSET_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "blink-icon-")),
  "AppIcon.iconset",
);

/** The ten renditions `iconutil` expects, as (filename, pixel size). */
const RENDITIONS: ReadonlyArray<{ name: string; px: number }> = [
  { name: "icon_16x16.png", px: 16 },
  { name: "icon_16x16@2x.png", px: 32 },
  { name: "icon_32x32.png", px: 32 },
  { name: "icon_32x32@2x.png", px: 64 },
  { name: "icon_128x128.png", px: 128 },
  { name: "icon_128x128@2x.png", px: 256 },
  { name: "icon_256x256.png", px: 256 },
  { name: "icon_256x256@2x.png", px: 512 },
  { name: "icon_512x512.png", px: 512 },
  { name: "icon_512x512@2x.png", px: 1024 },
];

/**
 * Hairlines vanish below 32px, so the eye outline thickens as the canvas
 * shrinks rather than scaling linearly.
 */
function strokeRatio(size: number): number {
  if (size <= 16) return 0.1;
  if (size <= 32) return 0.085;
  if (size <= 64) return 0.07;
  return 0.055;
}

function svg(size: number): string {
  // Apple's grid: the rounded rect covers ~80% of the canvas, leaving the
  // margin that makes icons optically align with system apps in a list.
  const margin = size * 0.0977;
  const box = size - margin * 2;
  const radius = size * 0.1807;

  // The tray glyph is drawn at 0.42 / 0.26 / 0.14 of its own 22px canvas;
  // scale those ratios to the tile so the icon reads as the same mark.
  const cx = size / 2;
  const cy = size / 2;
  const rx = box * 0.42;
  const ry = box * 0.26;
  const stroke = size * strokeRatio(size);
  const pupil = box * 0.14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">
    <rect x="${margin}" y="${margin}" width="${box}" height="${box}" rx="${radius}" ry="${radius}" fill="#FFFFFF"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#000000" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${pupil}" fill="#000000"/>
  </svg>`;
}

async function main(): Promise<void> {
  fs.mkdirSync(ICONSET_DIR, { recursive: true });

  const browser = await firefox.launch();
  try {
    for (const { name, px } of RENDITIONS) {
      const context = await browser.newContext({
        viewport: { width: px, height: px },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.setContent(`<!DOCTYPE html>
<html>
<head><style>
  html,body{margin:0;padding:0;background:transparent;width:${px}px;height:${px}px;overflow:hidden}
  svg{display:block}
</style></head>
<body>${svg(px)}</body>
</html>`);

      const dataUrl = await page.evaluate(async (size: number) => {
        const svgEl = document.querySelector("svg");
        if (!svgEl) throw new Error("svg missing");
        const svgSrc = new XMLSerializer().serializeToString(svgEl);
        const svgUrl = URL.createObjectURL(
          new Blob([svgSrc], { type: "image/svg+xml" }),
        );
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

      const buf = Buffer.from(
        dataUrl.replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      fs.writeFileSync(path.join(ICONSET_DIR, name), bytes);
      await context.close();
      console.log(`  ${name}  ${px}×${px}`);
    }
  } finally {
    await browser.close();
  }

  const result = spawnSync(
    "iconutil",
    ["-c", "icns", ICONSET_DIR, "-o", OUT_ICNS],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`iconutil exited with ${result.status}`);
  }

  fs.rmSync(path.dirname(ICONSET_DIR), { recursive: true, force: true });
  console.log(`\nWrote ${OUT_ICNS} (${fs.statSync(OUT_ICNS).size}B)`);
}

await main();
