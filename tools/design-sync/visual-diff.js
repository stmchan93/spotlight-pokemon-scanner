#!/usr/bin/env node
/**
 * Pixel-diff two screenshots for /sync-design.
 *
 * Usage:
 *   node tools/design-sync/visual-diff.js <a.png> <b.png> <diff-out.png> \
 *     [--threshold 3] [--crop-a x,y,w,h] [--crop-b x,y,w,h]
 *
 * Crops (in each image's own pixel space) exist to exclude expected
 * differences — status bar, tab bar, dynamic regions — instead of chasing them.
 * After optional crops, image B is resized to image A's dimensions, then
 * pixelmatch produces <diff-out.png> and a mismatch percentage.
 *
 * Exit codes: 0 mismatch < threshold (default 3%), 1 over threshold or error.
 */

const fs = require('node:fs');
const path = require('node:path');
// pixelmatch v7 is ESM-only; require() interop hands back a namespace object.
const pixelmatchModule = require('pixelmatch');
const pixelmatch = pixelmatchModule.default ?? pixelmatchModule;
const { PNG } = require('pngjs');
const sharp = require('sharp');

function parseArgs(argv) {
  const positional = [];
  const options = { cropA: null, cropB: null, threshold: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--threshold') {
      options.threshold = Number(argv[(index += 1)]);
    } else if (arg === '--crop-a' || arg === '--crop-b') {
      const [x, y, w, h] = String(argv[(index += 1)]).split(',').map(Number);
      options[arg === '--crop-a' ? 'cropA' : 'cropB'] = { height: h, left: x, top: y, width: w };
    } else {
      positional.push(arg);
    }
  }
  const [aPath, bPath, diffPath] = positional;
  if (!aPath || !bPath || !diffPath || !Number.isFinite(options.threshold)) {
    console.error(
      'usage: visual-diff.js <a.png> <b.png> <diff-out.png> [--threshold pct] [--crop-a x,y,w,h] [--crop-b x,y,w,h]',
    );
    process.exit(1);
  }
  return { aPath, bPath, diffPath, ...options };
}

async function loadRaw(filePath, crop, resizeTo) {
  let pipeline = sharp(filePath);
  if (crop) {
    pipeline = pipeline.extract(crop);
  }
  if (resizeTo) {
    pipeline = pipeline.resize(resizeTo.width, resizeTo.height, { fit: 'fill' });
  }
  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, height: info.height, width: info.width };
}

async function main() {
  const { aPath, bPath, diffPath, cropA, cropB, threshold } = parseArgs(process.argv.slice(2));

  const a = await loadRaw(aPath, cropA, null);
  const b = await loadRaw(bPath, cropB, { height: a.height, width: a.width });

  const diff = new PNG({ height: a.height, width: a.width });
  const mismatchedPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0.1,
  });

  fs.mkdirSync(path.dirname(diffPath), { recursive: true });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const mismatchPct = (mismatchedPixels / (a.width * a.height)) * 100;
  const verdict = mismatchPct < threshold ? 'PASS' : 'FAIL';
  console.log(
    `${verdict} mismatch=${mismatchPct.toFixed(2)}% threshold=${threshold}% ` +
      `(${mismatchedPixels}/${a.width * a.height} px, compared at ${a.width}x${a.height}) diff=${diffPath}`,
  );
  process.exit(mismatchPct < threshold ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
