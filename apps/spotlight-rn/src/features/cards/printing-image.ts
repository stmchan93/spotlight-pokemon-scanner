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

/** The version name to show beside the card number, or null. */
export function versionLabelForPrinting(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
): string | null {
  return isMatchedVersionShown(candidate, printingLabel) ? matchedVersionLabel(candidate) : null;
}

/**
 * The image depicting `candidate` on `printingLabel`: the matched version's
 * image when that version is shown, else the card's own (small first when
 * `preferSmall`, for thumbnails).
 */
export function candidateImageForPrinting(
  candidate: CatalogSearchResult | null | undefined,
  printingLabel: string | null | undefined,
  options: { preferSmall?: boolean; enabled?: boolean } = {},
): string | null {
  if (!candidate) {
    return null;
  }
  const versionImage = isMatchedVersionShown(candidate, printingLabel)
    ? matchedVersionImageUrl(candidate, options.enabled)
    : null;
  if (versionImage) {
    return versionImage;
  }
  return (options.preferSmall ? candidate.smallImageUrl || candidate.imageUrl : candidate.imageUrl) || null;
}

/** "#OP05-091 · Special Alt Art" parts: the number, then the version shown. */
export function cardNumberWithVersion(
  cardNumber: string | null | undefined,
  versionLabel: string | null | undefined,
): string | null {
  const number = cardNumber?.trim() ? `#${cardNumber.trim().replace(/^#/, '')}` : null;
  return [number, versionLabel || null].filter(Boolean).join(' · ') || null;
}

/** Per-printing images a card page can show in its header (matched version only today). */
export type PrintingImage = { label: string; imageUrl: string };

export function printingImagesForCandidate(
  candidate: CatalogSearchResult | null | undefined,
): PrintingImage[] | undefined {
  const label = matchedVersionLabel(candidate);
  const imageUrl = matchedVersionImageUrl(candidate);
  return label && imageUrl ? [{ label, imageUrl }] : undefined;
}

export function printingImageFor(
  images: readonly PrintingImage[] | null | undefined,
  printingLabel: string | null | undefined,
): string | null {
  return images?.find((entry) => printingLabelsMatch(entry.label, printingLabel))?.imageUrl ?? null;
}
