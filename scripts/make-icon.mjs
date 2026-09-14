/**
 * Renders the application icon.
 *
 * Run with Electron, not Node:
 *
 *   npx electron scripts/make-icon.mjs
 *
 * This machine has no SVG rasterizer, and Electron is already a
 * dependency — so the icon is drawn as a page, captured at each size
 * macOS wants, and assembled with iconutil.
 *
 * The mark is the product's central image: the letter D with the
 * operator's cursor crossing its bowl. The cursor carries a graphite
 * outline so the crossing reads as a notch in the letter rather than a
 * hole punched through it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, nativeImage } from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'packages/host/build');
const ICONSET = path.join(BUILD, 'icon.iconset');

const GRAPHITE = '#212120';
const AMBER = '#e0a03a';
const WHITE = '#ffffff';

/**
 * Drawn at 1024 and scaled down.
 *
 * The body is 824x824 inside a 1024 canvas with a corner radius of
 * 185.4 — Apple's macOS grid. macOS does not inset an icon for you, so
 * a mark drawn to the edge of the canvas stands taller than every
 * system icon beside it in the Dock. The 100-unit margin has to be in
 * the artwork, and the area outside it has to stay transparent.
 *
 * The mark is drawn in the same 1024 coordinates it was designed in and
 * scaled into the body by 824/1024, so its proportions against the
 * square are exactly what they were before the inset.
 *
 * The letter is one path with `fill-rule: evenodd`, so the counter is a
 * real hole. Painting it with a background-coloured patch instead would
 * mean the stock colour has to be repeated in two places, and the
 * counter would stop being transparent the moment either one changed.
 *
 * The counter is an ellipse, not a circle, and that is the whole of the
 * optical correction. Equal geometric weight does not read as equal
 * weight: a horizontal stroke of 84 looks heavier than a vertical one
 * of 84, so type design thins the horizontals by 8-12%. Here the outer
 * bowl stays a true circle of 296 and the counter keeps rx 212, which
 * holds the stem and the right of the bowl at a full 84; ry is raised
 * to 220, which brings the counter closer to the outer edge at the top
 * and the bottom and takes the two arms to 76 — 9.5% thinner. The
 * joins stay tangent-continuous, because the top of an ellipse has a
 * horizontal tangent exactly as the top of a circle does.
 *
 * So the three numbers move together: change `lr` or the stroke and the
 * counter's ry has to be recomputed as lr minus the thinned horizontal,
 * or the correction silently becomes something else.
 *
 * The cursor's outline is 15 units on this canvas, so it is divided by
 * the group's own scale — `transform` scales stroke width along with
 * geometry, and an outline that grows with the arrow swallows its tail.
 */
const PAGE = `
<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; }
</style>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="${GRAPHITE}"/>
  <g transform="translate(100 100) scale(0.8046875)">
    <path fill="${AMBER}" fill-rule="evenodd"
          d="M 262 216 h188 a296 296 0 0 1 0 592 h-188 z
             M 346 292 h104 a212 220 0 0 1 0 440 h-104 z"/>
    <g transform="translate(543 606) rotate(-6) scale(0.74)">
      <path fill="${WHITE}" stroke="${GRAPHITE}" stroke-width="20.3" stroke-linejoin="round"
            d="M 0 0 L 0 290 L 78.7 240.5 L 146.8 374.1 L 216.3 338.7 L 148.2 205 L 234.6 170.5 Z"/>
    </g>
  </g>
</svg>
`;

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

app.whenReady().then(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });

  fs.writeFileSync(path.join(BUILD, 'icon.png'), full.toPNG());

  for (const size of SIZES) {
    const scaled = full.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(ICONSET, `icon_${size}x${size}.png`), scaled.toPNG());

    // macOS wants each size again as the @2x of the size below it.
    const half = size / 2;
    if (SIZES.includes(half) && half >= 16) {
      fs.writeFileSync(path.join(ICONSET, `icon_${half}x${half}@2x.png`), scaled.toPNG());
    }
  }

  try {
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', ICONSET, '-o', path.join(BUILD, 'icon.icns')]);
    fs.rmSync(ICONSET, { recursive: true, force: true });
    console.log('[icon] built packages/host/build/icon.icns');
  } catch (err) {
    console.error('[icon] iconutil failed:', err.message);
  }

  console.log('[icon] built packages/host/build/icon.png (1024x1024)');
  win.destroy();
  app.quit();
});

// nativeImage is imported for its resize/toPNG surface via capturePage.
void nativeImage;
