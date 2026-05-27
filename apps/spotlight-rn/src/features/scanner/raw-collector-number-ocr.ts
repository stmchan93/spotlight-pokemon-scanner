import {
  isSlabScannerNativeAvailable,
  scanPSALabel,
  SLAB_SCANNER_NATIVE_MODULE_NAME,
  type SlabScannerNativeAnalysis,
  type SlabScannerTextBlock,
} from '@/features/scanner/slab-scanner-native';

/**
 * Phase 2 collector-number tiebreak (CLIENT side).
 *
 * Runs the SAME on-device ML Kit text reader the slab lane uses, but on the
 * RAW normalized capture, and extracts the printed footer collector number
 * (e.g. "087/162" or "TG12"). This is forwarded to the backend as a SECONDARY
 * verification signal only — it never becomes a primary identifier and is never
 * used as a hard filter. The backend gate (SPOTLIGHT_VISUAL_COLLECTOR_TIEBREAK)
 * only nudges a same-art/different-number lookalike candidate up on a near-tie.
 *
 * The native text reader (SpotlightSlabScanner) only exists in a custom dev
 * build. In Expo Go (or any build without the native module) this no-ops
 * gracefully and returns null.
 */

// Pokemon collector numbers appear as either "<number>/<total>" (e.g. 087/162),
// a bare number, a set-prefixed token (e.g. TG12, SWSH123, GG01), or a
// set-prefixed pair (e.g. TG12/TG30). We accept an optional alpha prefix and
// required digits on each side of an optional "/".
const COLLECTOR_NUMBER_TOKEN = /\b([A-Za-z]{0,6}\d{1,4}(?:\/[A-Za-z]{0,6}\d{1,4})?)\b/;

// A token is only a plausible collector number if it actually contains a digit
// run of 1-4 digits. Reject obvious non-collector noise (years, long IDs, HP).
const PLAUSIBLE_NUMERIC = /^\d{1,4}$/;

function isHpLine(line: string): boolean {
  // "HP120", "120HP", "120 HP" footers — the HP value is not a collector number.
  // Checked at line granularity so a bare "120" adjacent to "HP" is also rejected.
  return /\bhp\b/i.test(line) || /hp\s*\d|\d\s*hp/i.test(line);
}

/**
 * Extract a collector-number token from raw OCR text. Pure function (no native
 * dependency) so it is fully unit-testable.
 *
 * Prefers the LAST matching token in the text because the collector number sits
 * in the card footer (bottom-most text), after copyright/illustrator lines.
 * Prefers a slashed "number/total" form over a bare number when both exist.
 */
export function extractRawCollectorNumber(rawText: string | null | undefined): string | null {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return null;
  }

  const candidates: string[] = [];
  // Scan line-by-line so we can prefer footer (later) lines.
  for (const line of rawText.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // "HP" lines carry the hit-point value, never a collector number.
    if (isHpLine(trimmed)) {
      continue;
    }
    // Find ALL matches on the line, not just the first.
    const lineRegex = new RegExp(COLLECTOR_NUMBER_TOKEN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(trimmed)) != null) {
      const token = match[1];
      if (!token) {
        continue;
      }
      // Reject a standalone 4-digit year (e.g. a copyright "2024"): almost
      // always copyright, not a collector number. Only when it's a bare number.
      if (PLAUSIBLE_NUMERIC.test(token) && /^(19|20)\d{2}$/.test(token)) {
        continue;
      }
      candidates.push(token);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Prefer a slashed "number/total" form (most specific) anywhere, otherwise the
  // last (footer-most) token.
  const slashed = candidates.filter((token) => token.includes('/'));
  if (slashed.length > 0) {
    return slashed[slashed.length - 1];
  }
  return candidates[candidates.length - 1];
}

/**
 * Collect the joined text from the bottom region of the normalized capture,
 * where the collector number is printed. The native analysis returns absolute
 * pixel bounding boxes; we keep blocks whose vertical center is in the bottom
 * fraction of the image.
 */
export function collectFooterText(
  analysis: SlabScannerNativeAnalysis,
  bottomFraction = 0.35,
): string {
  const height = typeof analysis.height === 'number' && analysis.height > 0 ? analysis.height : 0;
  const blocks: SlabScannerTextBlock[] = Array.isArray(analysis.textBlocks)
    ? analysis.textBlocks
    : [];

  if (height === 0) {
    // No usable geometry — fall back to all text.
    return blocks.map((block) => block.text).filter(Boolean).join('\n');
  }

  const threshold = height * (1 - bottomFraction);
  const footerBlocks = blocks.filter((block) => {
    const box = block.boundingBox;
    if (!box || typeof box.y !== 'number' || typeof box.height !== 'number') {
      // No geometry on this block — include it so we don't lose the number.
      return true;
    }
    const centerY = box.y + box.height / 2;
    return centerY >= threshold;
  });

  const source = footerBlocks.length > 0 ? footerBlocks : blocks;
  return source.map((block) => block.text).filter(Boolean).join('\n');
}

export function isRawCollectorNumberOcrAvailable(): boolean {
  return isSlabScannerNativeAvailable();
}

/**
 * Run the on-device text reader on the raw normalized capture and return the
 * extracted footer collector number, or null. Never throws — any native /
 * availability failure resolves to null so the caller can run this concurrently
 * with the network match without risking the scan.
 */
export async function readRawCollectorNumber(imageUri: string): Promise<string | null> {
  if (typeof imageUri !== 'string' || imageUri.trim().length === 0) {
    return null;
  }
  if (!isSlabScannerNativeAvailable()) {
    // Expo Go / no custom dev client: graceful no-op.
    if (__DEV__ && process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(
        `[raw-collector-ocr] native module ${SLAB_SCANNER_NATIVE_MODULE_NAME} unavailable; skipping`,
      );
    }
    return null;
  }

  try {
    const analysis = await scanPSALabel(imageUri.trim());
    const footerText = collectFooterText(analysis);
    return extractRawCollectorNumber(footerText);
  } catch {
    // Secondary signal only — never let OCR failure affect the scan.
    return null;
  }
}
