#!/usr/bin/env node
/**
 * Export a Figma node as a PNG via the Figma REST API, for /sync-design pixel
 * diffs against simulator screenshots.
 *
 * Usage:
 *   FIGMA_TOKEN=... node tools/design-sync/figma-export.js <file-key-or-url> <node-id> <out.png> [scale]
 *
 * <file-key-or-url> — the file key, or a full https://www.figma.com/design/... URL
 *                     (the key and node-id are parsed out of it; an explicit
 *                     <node-id> argument still wins).
 * <node-id>         — accepts both "4299-94902" and "4299:94902" forms.
 *
 * Exit codes: 0 exported, 2 no FIGMA_TOKEN (caller falls back to Claude
 * comparing against the Figma MCP screenshot), 1 error.
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const [fileArg, nodeArg, outArg, scaleArg] = argv;
  if (!fileArg || !outArg) {
    console.error(
      'usage: figma-export.js <file-key-or-url> <node-id> <out.png> [scale]',
    );
    process.exit(1);
  }

  let fileKey = fileArg;
  let nodeId = nodeArg;
  if (/^https?:\/\//i.test(fileArg)) {
    const url = new URL(fileArg);
    const match = url.pathname.match(/\/(?:design|file)\/([A-Za-z0-9]+)/);
    if (!match) {
      console.error(`Could not parse a Figma file key from URL: ${fileArg}`);
      process.exit(1);
    }
    fileKey = match[1];
    if (!nodeId || nodeId === '-') {
      nodeId = url.searchParams.get('node-id') ?? '';
    }
  }
  if (!nodeId) {
    console.error('No node id: pass it as the second argument or in the URL (?node-id=...).');
    process.exit(1);
  }
  // REST API wants "1234:5678"; Figma URLs carry "1234-5678".
  nodeId = nodeId.replace(/-/g, ':');
  return { fileKey, nodeId, outPath: outArg, scale: Number(scaleArg ?? 2) || 2 };
}

async function main() {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error(
      'No FIGMA_TOKEN set — skipping REST export. Visual comparison will be done by Claude directly against the Figma MCP screenshot instead.',
    );
    process.exit(2);
  }

  const { fileKey, nodeId, outPath, scale } = parseArgs(process.argv.slice(2));
  const apiUrl =
    `https://api.figma.com/v1/images/${fileKey}` +
    `?ids=${encodeURIComponent(nodeId)}&scale=${scale}&format=png`;

  const response = await fetch(apiUrl, { headers: { 'X-Figma-Token': token } });
  if (!response.ok) {
    console.error(`Figma API error ${response.status}: ${await response.text()}`);
    process.exit(1);
  }
  const payload = await response.json();
  if (payload.err) {
    console.error(`Figma API error: ${payload.err}`);
    process.exit(1);
  }
  const imageUrl = payload.images?.[nodeId];
  if (!imageUrl) {
    console.error(
      `No image returned for node ${nodeId}. Nodes in response: ${Object.keys(payload.images ?? {}).join(', ') || '(none)'}`,
    );
    process.exit(1);
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    console.error(`Image download failed: ${imageResponse.status}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(await imageResponse.arrayBuffer()));
  console.log(`figma export: ${outPath} (node ${nodeId} @ ${scale}x)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
