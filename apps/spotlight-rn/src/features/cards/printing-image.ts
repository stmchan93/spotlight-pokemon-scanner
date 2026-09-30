import type { CatalogSearchResult } from '@spotlight/api-client';

import { buildTcgPlayerProductImageUrl } from '@/features/cards/marketplace-urls';
import { resolveShowMatchedVariantImage } from '@/lib/runtime-config';

/**
 * How a scan candidate's matched art version (backend `matchedVariant`, e.g.
 * "Special Alt Art") is depicted. The candidate's own image is the base art;
 * when the photo matched a different version, every surface showing that
 * candidate shows the version's image and names it — otherwise a correct
 * alt-art match reads as a wrong scan.
 */

// Read once: the flag is build/OTA config, and this runs on every row render.
let matchedVariantImageFlag: boolean | null = null;
export function matchedVariantImageEnabled() {
  matchedVariantImageFlag ??= resolveShowMatchedVariantImage();
  return matchedVariantImageFlag;
}

/** Test hook: re-read the flag on the next call. */
export function resetMatchedVariantImageFlagForTests() {
  matchedVariantImageFlag = null;
}

function normalizePrintingLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function printingLabelsMatch(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && normalizePrintingLabel(a) === normalizePrintingLabel(b);
}

/** The art version the scan photo matched, or null for a base-art match. */
export function matchedVersionLabel(candidate: CatalogSearchResult | null | undefined): string | null {
  const label = candidate?.matchedVariant?.label;
  return typeof label === 'string' && label.trim().length > 0 ? label.trim() : null;
}

/** The matched version's image (its TCGplayer product image), when showable. */
export function matchedVersionImageUrl(
  candidate: CatalogSearchResult | null | undefined,
  enabled: boolean = matchedVariantImageEnabled(),
): string | null {
  const matched = candidate?.matchedVariant;
  if (!enabled || !matched || !matchedVersionLabel(candidate)) {
    return null;
  }
  return matched.imageUrl || buildTcgPlayerProductImageUrl(matched.tcgplayerProductId);
}

/**
 * True when the printing on screen is the matched version. `printingLabel` is
 * the printing the row is on; null means none is chosen yet, which starts on
 * the matched version. A different printing (the base, or another one we have
 * no image for) shows the card's own art.
 */
export function isMatchedVersionShown(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
): boolean {
  const label = matchedVersionLabel(candidate);
  if (!label) {
    return false;
  }
  return printingLabel == null || printingLabelsMatch(label, printingLabel);
}

/** The candidate's art-changing printing (backend `printingImages`) named `printingLabel`, if any. */
function candidatePrintingImageEntry(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
) {
  return printingLabel
    ? candidate?.printingImages?.find((entry) => printingLabelsMatch(entry.label, printingLabel)) ?? null
    : null;
}

/** The version name to show beside the card number, or null. */
export function versionLabelForPrinting(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
): string | null {
  if (isMatchedVersionShown(candidate, printingLabel)) {
    return matchedVersionLabel(candidate);
  }
  return candidatePrintingImageEntry(candidate, printingLabel)?.label ?? null;
}

/**
 * The art of the printing on screen when it differs from the card's: the
 * matched version's image while that version is shown, else the chosen
 * printing's own art (an alt art the scan did not match). Null = card image.
 */
export function candidatePrintingArtUrl(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
  options: { preferSmall?: boolean; enabled?: boolean } = {},
): string | null {
  const enabled = options.enabled ?? matchedVariantImageEnabled();
  if (!candidate || !enabled) {
    return null;
  }
  if (isMatchedVersionShown(candidate, printingLabel)) {
    const versionImage = matchedVersionImageUrl(candidate, enabled);
    if (versionImage) {
      return versionImage;
    }
  }
  const entry = candidatePrintingImageEntry(candidate, printingLabel);
  if (!entry) {
    return null;
  }
  return (options.preferSmall ? entry.smallImageUrl || entry.imageUrl : entry.imageUrl) || null;
}

/**
 * The image depicting `candidate` on `printingLabel`: that printing's art when
 * it differs (see `candidatePrintingArtUrl`), else the card's own (small first
 * when `preferSmall`, for thumbnails).
 */
export function candidateImageForPrinting(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
  options: { preferSmall?: boolean; enabled?: boolean } = {},
): string | null {
  if (!candidate) {
    return null;
  }
  return candidatePrintingArtUrl(candidate, printingLabel, options)
    || (options.preferSmall ? candidate.smallImageUrl || candidate.imageUrl : candidate.imageUrl)
    || null;
}

/** "#OP05-091 · Special Alt Art" parts: the number, then the version shown. */
export function cardNumberWithVersion(
  cardNumber: string | null | undefined,
  versionLabel: string | null | undefined,
): string | null {
  const number = cardNumber?.trim() ? `#${cardNumber.trim().replace(/^#/, '')}` : null;
  return [number, versionLabel || null].filter(Boolean).join(' · ') || null;
}

/** Per-printing images a card page can show in its header. */
export type PrintingImage = { label: string; imageUrl: string };

/** The matched version's image first, then the candidate's other art-changing printings. */
export function printingImagesForCandidate(
  candidate: CatalogSearchResult | null | undefined,
): PrintingImage[] | undefined {
  const label = matchedVersionLabel(candidate);
  const imageUrl = matchedVersionImageUrl(candidate);
  const images: PrintingImage[] = label && imageUrl ? [{ label, imageUrl }] : [];
  if (matchedVariantImageEnabled()) {
    for (const entry of candidate?.printingImages ?? []) {
      images.push({ label: entry.label, imageUrl: entry.imageUrl });
    }
  }
  return images.length > 0 ? images : undefined;
}

/**
 * Printing images carried by owned copies / watched printings (backend
 * `printingImageUrl`, set only for alt-art versions), keyed by their printing.
 */
export function printingImagesForEntries(
  entries: readonly { printingLabel?: string | null; printingImageUrl?: string | null }[],
): PrintingImage[] | undefined {
  const images = entries.flatMap(({ printingLabel, printingImageUrl }) =>
    printingLabel?.trim() && printingImageUrl ? [{ label: printingLabel.trim(), imageUrl: printingImageUrl }] : [],
  );
  return images.length > 0 ? images : undefined;
}

export function printingImageFor(
  images: readonly PrintingImage[] | null | undefined,
  printingLabel: string | null | undefined,
): string | null {
  return images?.find((entry) => printingLabelsMatch(entry.label, printingLabel))?.imageUrl ?? null;
}
